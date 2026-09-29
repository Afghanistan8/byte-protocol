/**
 * Byte as an AP2 payment method, carried over A2A.
 *
 * AP2 chains three signed mandates — Intent, Cart, Payment — and inside the Cart Mandate
 * sits a W3C `PaymentRequest` listing the payment methods a merchant accepts. Byte plugs in
 * there, as one more accepted method, identified by its native scheme name.
 *
 * ## What this adapter does and does not do
 *
 * It provides **the payment method**: building the `PaymentMethodData` a merchant publishes,
 * recovering a Byte invoice from a cart, settling it, and verifying the result.
 *
 * It does **not** implement AP2's mandate chain — the merchant's `merchant_authorization`
 * JWT, the cart hash, or the Intent → Cart → Payment signing flow. Those are AP2's own
 * integrity mechanisms and belong to an AP2 implementation, not to a settlement layer. Byte
 * answers "the payment happened, shielded, and here is proof"; it does not answer "the user
 * authorised this cart".
 *
 * Field names below are AP2's, which are snake_case, taken from
 * `ap2/models/mandate.py` and `ap2/models/payment_request.py`.
 */

import {
  BYTE_SCHEME,
  ByteProtocolError,
  isByteNetwork,
  type BytePaymentRequirements,
  type ByteNetwork,
} from "@byte-protocol/core";

/** DataPart keys AP2 uses to carry mandates inside A2A messages. */
export const CART_MANDATE_DATA_KEY = "ap2.mandates.CartMandate";
export const INTENT_MANDATE_DATA_KEY = "ap2.mandates.IntentMandate";
export const PAYMENT_MANDATE_DATA_KEY = "ap2.mandates.PaymentMandate";

/**
 * The payment method identifier a merchant advertises.
 *
 * Byte's native scheme name, not the x402 mapping. AP2 identifies a method by a single
 * string, so the name has to carry the network too — which it does not — hence `network`
 * inside `data`.
 */
export const BYTE_PAYMENT_METHOD = BYTE_SCHEME;

/** The `data` Byte carries inside an AP2 `PaymentMethodData`. */
export interface BytePaymentMethodPayload {
  network: ByteNetwork;
  /** Zatoshis, canonical integer string. */
  amount: string;
  asset: "ZEC";
  payTo: string;
  invoice_id: string;
  memo: string;
  zip321: string;
  min_confirmations: number;
  /** RFC 3339 UTC. */
  expires_at: string;
}

/** W3C `PaymentMethodData`, as AP2 profiles it. */
export interface PaymentMethodData {
  supported_methods: string;
  data?: Record<string, unknown>;
}

/** Enough of AP2's `PaymentRequest` for Byte's purposes. */
export interface Ap2PaymentRequest {
  method_data: PaymentMethodData[];
  [key: string]: unknown;
}

/** Enough of AP2's `CartMandate` for Byte's purposes. */
export interface Ap2CartMandate {
  contents: {
    id: string;
    payment_request: Ap2PaymentRequest;
    cart_expiry?: string;
    [key: string]: unknown;
  };
  merchant_authorization?: string | null;
  [key: string]: unknown;
}

/** Advertise a Byte invoice as an AP2 payment method. */
export function toPaymentMethodData(invoice: BytePaymentRequirements): PaymentMethodData {
  return {
    supported_methods: BYTE_PAYMENT_METHOD,
    data: {
      network: invoice.network,
      amount: invoice.amount,
      asset: "ZEC",
      payTo: invoice.payTo,
      invoice_id: invoice.invoiceId,
      memo: invoice.memo,
      zip321: invoice.zip321,
      min_confirmations: invoice.minConfirmations,
      expires_at: invoice.expiresAt,
    } satisfies BytePaymentMethodPayload,
  };
}

/**
 * Recover a Byte invoice from AP2 payment method data.
 *
 * Validated rather than trusted: this arrived from a merchant agent, and every field
 * decides where money goes.
 */
export function fromPaymentMethodData(method: unknown): BytePaymentRequirements {
  const m = method as Partial<PaymentMethodData> | null;
  if (typeof m !== "object" || m === null) {
    throw new ByteProtocolError("payment method data is not an object");
  }
  if (m.supported_methods !== BYTE_PAYMENT_METHOD) {
    throw new ByteProtocolError(
      `expected payment method ${BYTE_PAYMENT_METHOD}, got ${m.supported_methods}`,
    );
  }

  const d = m.data as Partial<BytePaymentMethodPayload> | undefined;
  if (typeof d !== "object" || d === null) {
    throw new ByteProtocolError("Byte payment method carries no data");
  }
  if (!isByteNetwork(d.network)) {
    throw new ByteProtocolError(`${d.network} is not a Byte network`);
  }
  if (d.asset !== "ZEC") {
    throw new ByteProtocolError(`expected asset ZEC, got ${d.asset}`);
  }
  for (const field of ["amount", "payTo", "invoice_id", "memo", "zip321", "expires_at"] as const) {
    if (typeof d[field] !== "string") {
      throw new ByteProtocolError(`Byte payment method data is missing ${field}`);
    }
  }
  if (typeof d.min_confirmations !== "number") {
    throw new ByteProtocolError("Byte payment method data is missing min_confirmations");
  }

  return {
    scheme: BYTE_SCHEME,
    network: d.network,
    amount: d.amount as string,
    asset: "ZEC",
    payTo: d.payTo as string,
    invoiceId: d.invoice_id as string,
    expiresAt: d.expires_at as string,
    minConfirmations: d.min_confirmations,
    memo: d.memo as string,
    zip321: d.zip321 as string,
  };
}

/**
 * Find the Byte invoice a cart offers, if it offers one.
 *
 * Returns undefined when the merchant accepts no Byte method, so a client can fall back to
 * another payment method rather than failing.
 */
export function byteInvoiceFromCart(
  cart: Ap2CartMandate,
): BytePaymentRequirements | undefined {
  const methods = cart.contents?.payment_request?.method_data;
  if (!Array.isArray(methods)) return undefined;

  const byteMethod = methods.find(
    (m) => (m as PaymentMethodData)?.supported_methods === BYTE_PAYMENT_METHOD,
  );
  if (byteMethod === undefined) return undefined;

  return fromPaymentMethodData(byteMethod);
}

/** The Byte claim a payer puts in its Payment Mandate's data. */
export interface BytePaymentMandateData {
  supported_methods: typeof BYTE_PAYMENT_METHOD;
  data: {
    invoice_id: string;
    txid: string;
    network: ByteNetwork;
  };
}

export function toPaymentMandateData(claim: {
  invoiceId: string;
  txid: string;
  network: ByteNetwork;
}): BytePaymentMandateData {
  return {
    supported_methods: BYTE_PAYMENT_METHOD,
    data: { invoice_id: claim.invoiceId, txid: claim.txid, network: claim.network },
  };
}

/** Recover a Byte claim from a Payment Mandate's data. */
export function fromPaymentMandateData(value: unknown): { invoiceId: string; txid: string } {
  const v = value as Partial<BytePaymentMandateData> | null;
  if (typeof v !== "object" || v === null) {
    throw new ByteProtocolError("payment mandate data is not an object");
  }
  if (v.supported_methods !== BYTE_PAYMENT_METHOD) {
    throw new ByteProtocolError("payment mandate is not for the Byte payment method");
  }
  const d = v.data;
  if (typeof d !== "object" || d === null || typeof d.invoice_id !== "string" || typeof d.txid !== "string") {
    throw new ByteProtocolError("payment mandate data carries no invoice_id and txid");
  }
  return { invoiceId: d.invoice_id, txid: d.txid };
}

/** Build the A2A DataPart that carries a value under an AP2 mandate key. */
export function dataPart(key: string, value: unknown): { kind: "data"; data: Record<string, unknown> } {
  return { kind: "data", data: { [key]: value } };
}

/** Read a value out of an A2A DataPart list by its AP2 key. */
export function readDataPart(parts: unknown, key: string): unknown {
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    const data = (part as { data?: Record<string, unknown> })?.data;
    if (data !== undefined && key in data) return data[key];
  }
  return undefined;
}
