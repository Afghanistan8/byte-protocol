/**
 * Byte as an x402 v2 payment scheme.
 *
 * x402 separates *how money moves* (`scheme`) from *where* (`network`). Byte's movement is
 * ordinary "pay exactly this amount to this address", which is x402's `exact`; what is
 * unusual is the network. So this adapter maps onto `scheme: "exact"` rather than
 * inventing a parallel scheme, and carries Byte's specifics in `extra`.
 *
 * That is the same shape the Lightning scheme already in the x402 repository uses, and it
 * matters: a Zcash scheme spec written this way is a contribution to x402 rather than a
 * dialect of it. There is currently no Zcash scheme in that repository.
 *
 * Header and field names are from `specs/x402-specification-v2.md`. The v1 names
 * `X-PAYMENT` and `X-PAYMENT-RESPONSE` are not used.
 */

import {
  BYTE_SCHEME,
  X402_SCHEME,
  X402_VERSION,
  ByteProtocolError,
  isByteNetwork,
  type BytePaymentPayload,
  type BytePaymentRequirements,
  type ByteNetwork,
} from "@byte-protocol/core";

/** x402 v2 response header carrying `PaymentRequired`, base64-encoded JSON. */
export const PAYMENT_REQUIRED_HEADER = "payment-required";

/** x402 v2 request header carrying `PaymentPayload`, base64-encoded JSON. */
export const PAYMENT_SIGNATURE_HEADER = "payment-signature";

/** x402 v2 sidechannel header for extension outcomes. */
export const EXTENSION_RESPONSES_HEADER = "extension-responses";

/** The `extra` object Byte carries inside x402 `PaymentRequirements`. */
export interface ByteExtra {
  /** Byte's native scheme identifier, for consumers that speak Byte directly. */
  byteScheme: typeof BYTE_SCHEME;
  invoiceId: string;
  /** The exact memo the payer must attach. */
  memo: string;
  /** A ZIP-321 URI encoding the same payment. */
  zip321: string;
  minConfirmations: number;
}

export interface X402PaymentRequirements {
  scheme: typeof X402_SCHEME;
  network: ByteNetwork;
  /** Zatoshis, as a decimal string in atomic units. */
  amount: string;
  asset: "ZEC";
  payTo: string;
  maxTimeoutSeconds: number;
  extra: ByteExtra;
}

export interface X402PaymentRequired {
  x402Version: typeof X402_VERSION;
  accepts: X402PaymentRequirements[];
  error?: string;
}

export interface X402PaymentPayload {
  x402Version: typeof X402_VERSION;
  accepted: X402PaymentRequirements;
  payload: { txid: string; invoiceId: string };
}

export interface X402SettlementResponse {
  success: boolean;
  /** The transaction identifier, or an empty string if nothing was broadcast. */
  transaction: string;
  network: ByteNetwork;
  errorReason?: string;
  amount?: string;
  /**
   * Deliberately absent.
   *
   * x402 allows an optional `payer`. A Byte payment has no payer identity to report — that
   * is the entire point of settling in a shielded pool — so the field is never populated,
   * the same position the Lightning scheme takes for the same reason.
   */
  payer?: never;
}

/** Seconds remaining until an invoice expires, floored at zero. */
function maxTimeoutSeconds(expiresAt: string, now: number): number {
  const remaining = Math.floor((Date.parse(expiresAt) - now) / 1000);
  return remaining > 0 ? remaining : 0;
}

/** Map a Byte invoice onto x402 v2 payment requirements. */
export function toX402Requirements(
  invoice: BytePaymentRequirements,
  now: number = Date.now(),
): X402PaymentRequirements {
  return {
    scheme: X402_SCHEME,
    network: invoice.network,
    amount: invoice.amount,
    asset: "ZEC",
    payTo: invoice.payTo,
    maxTimeoutSeconds: maxTimeoutSeconds(invoice.expiresAt, now),
    extra: {
      byteScheme: BYTE_SCHEME,
      invoiceId: invoice.invoiceId,
      memo: invoice.memo,
      zip321: invoice.zip321,
      minConfirmations: invoice.minConfirmations,
    },
  };
}

/** Wrap requirements in the `PaymentRequired` object the 402 carries. */
export function toX402PaymentRequired(
  invoice: BytePaymentRequirements,
  options: { now?: number; error?: string } = {},
): X402PaymentRequired {
  return {
    x402Version: X402_VERSION,
    accepts: [toX402Requirements(invoice, options.now ?? Date.now())],
    ...(options.error !== undefined ? { error: options.error } : {}),
  };
}

/**
 * Recover a Byte invoice from x402 requirements.
 *
 * Validates rather than trusts: these arrive from a server that may be hostile or merely
 * broken, and every field influences where money goes.
 */
export function fromX402Requirements(
  requirements: unknown,
  now: number = Date.now(),
): BytePaymentRequirements {
  const r = requirements as Partial<X402PaymentRequirements> | null;
  if (typeof r !== "object" || r === null) {
    throw new ByteProtocolError("x402 requirements are not an object");
  }
  if (r.scheme !== X402_SCHEME) {
    throw new ByteProtocolError(`expected x402 scheme "${X402_SCHEME}", got ${r.scheme}`);
  }
  if (!isByteNetwork(r.network)) {
    throw new ByteProtocolError(`${r.network} is not a Byte network`);
  }
  if (r.asset !== "ZEC") {
    throw new ByteProtocolError(`expected asset ZEC, got ${r.asset}`);
  }

  const extra = r.extra;
  if (
    typeof extra !== "object" ||
    extra === null ||
    extra.byteScheme !== BYTE_SCHEME ||
    typeof extra.invoiceId !== "string" ||
    typeof extra.memo !== "string" ||
    typeof extra.zip321 !== "string" ||
    typeof extra.minConfirmations !== "number"
  ) {
    throw new ByteProtocolError(
      "x402 requirements carry no Byte extra; this is not a Byte-settled invoice",
    );
  }
  if (typeof r.amount !== "string" || typeof r.payTo !== "string") {
    throw new ByteProtocolError("x402 requirements are missing amount or payTo");
  }

  const timeout = typeof r.maxTimeoutSeconds === "number" ? r.maxTimeoutSeconds : 0;

  return {
    scheme: BYTE_SCHEME,
    network: r.network,
    amount: r.amount,
    asset: "ZEC",
    payTo: r.payTo,
    invoiceId: extra.invoiceId,
    expiresAt: new Date(now + timeout * 1000).toISOString(),
    minConfirmations: extra.minConfirmations,
    memo: extra.memo,
    zip321: extra.zip321,
  };
}

/** Build the x402 payload a payer returns after settling. */
export function toX402Payload(
  accepted: X402PaymentRequirements,
  payment: BytePaymentPayload,
): X402PaymentPayload {
  return {
    x402Version: X402_VERSION,
    accepted,
    payload: { txid: payment.txid, invoiceId: payment.invoiceId },
  };
}

/** Recover the claim from an x402 payload. */
export function fromX402Payload(payload: unknown): { invoiceId: string; txid: string } {
  const p = payload as Partial<X402PaymentPayload> | null;
  if (typeof p !== "object" || p === null) {
    throw new ByteProtocolError("x402 payload is not an object");
  }
  if (p.x402Version !== X402_VERSION) {
    throw new ByteProtocolError(`expected x402Version ${X402_VERSION}, got ${p.x402Version}`);
  }
  const inner = p.payload;
  if (
    typeof inner !== "object" ||
    inner === null ||
    typeof inner.txid !== "string" ||
    typeof inner.invoiceId !== "string"
  ) {
    throw new ByteProtocolError("x402 payload carries no txid and invoiceId");
  }
  return { invoiceId: inner.invoiceId, txid: inner.txid };
}

/** Base64-encode an object for an x402 header. */
export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** Decode a base64 x402 header. */
export function decodeHeader(header: string | null | undefined): unknown {
  if (header === null || header === undefined || header === "") return undefined;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch (cause) {
    throw new ByteProtocolError("x402 header is not base64-encoded JSON", { cause });
  }
}
