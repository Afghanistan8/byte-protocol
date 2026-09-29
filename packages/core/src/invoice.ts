/**
 * Invoice and payload shapes, with runtime validation.
 *
 * Everything crossing a network boundary is parsed through these schemas rather than
 * trusted. Types alone are a compile-time fiction once JSON arrives from a peer.
 *
 * See docs/SPEC.md §5.
 */

import { z } from "zod";
import { isZat } from "./amount.js";
import { isHex } from "./bytes.js";
import { BYTE_SCHEME, NETWORKS } from "./network.js";
import { isUsd } from "./price.js";
import { BINDING_BYTES, INVOICE_ID_BYTES } from "./memo.js";

const zatoshis = z
  .string()
  .refine(isZat, "must be a base-10 integer string of zatoshis within the maximum supply");

const invoiceId = z
  .string()
  .refine((v) => isHex(v, INVOICE_ID_BYTES), `must be ${INVOICE_ID_BYTES * 2} lowercase hex characters`);

const rfc3339 = z.iso.datetime({ offset: true });

/**
 * A transaction identifier: 32 bytes, lowercase hex.
 *
 * Note that Zcash displays txids byte-reversed from their internal representation. Byte
 * carries whatever the wallet backend reports and compares it as an opaque string; it
 * never reverses or re-derives one.
 */
const txid = z.string().refine((v) => isHex(v, 32), "must be 64 lowercase hex characters");

const network = z.enum(NETWORKS);

/**
 * The quote a USD-priced invoice was locked at.
 *
 * Present only when a merchant priced in USD. Carried on the wire so a payer can see the
 * rate they are being charged at and refuse one they disagree with — the alternative is
 * a payer that must trust an amount with no way to sanity-check it.
 *
 * Purely informational to the verifier. Settlement is judged against `amount` alone; this
 * is never re-derived, re-priced or re-checked. See `core/src/price.ts`.
 */
export const PriceQuoteSchema = z.object({
  /** Decimal USD, at most two places. */
  priceUsd: z.string().refine(isUsd, "must be decimal USD with at most two places"),
  /** The USD-per-ZEC rate used. */
  zecUsd: z.number().positive().finite(),
  /** Which source, or sources, produced it. */
  priceSource: z.string().min(1),
  quotedAt: z.iso.datetime({ offset: true }),
});

export type PriceQuote = z.infer<typeof PriceQuoteSchema>;

/** The payment requirements a payee sends with a 402. */
export const BytePaymentRequirementsSchema = z.object({
  scheme: z.literal(BYTE_SCHEME),
  network,
  /** Zatoshis. A string, not a number. */
  amount: zatoshis,
  /**
   * The settlement asset. `ZEC` and only `ZEC`.
   *
   * A literal rather than an open string, on purpose. Zcash has no stablecoin and ZSAs
   * are not on mainnet, so anything else arriving here means a peer is describing a chain
   * Byte does not settle on. When ZSAs ship this becomes a union and the verifier learns
   * to check an asset identifier against the note — that is a protocol change with a
   * consensus dependency, not a field widening, and it stays **Planned** until then.
   */
  asset: z.literal("ZEC"),
  /** A fresh diversified unified address, minted for this invoice alone. */
  payTo: z.string().min(1),
  invoiceId,
  expiresAt: rfc3339,
  minConfirmations: z.int().min(0),
  /** The exact memo the payer must attach. */
  memo: z.string().min(1),
  /** A ZIP-321 URI encoding the same payment. */
  zip321: z.string().startsWith("zcash:"),
  facilitator: z.url().optional(),
  /** Present only when the merchant priced in USD. */
  price: PriceQuoteSchema.optional(),
});

export type BytePaymentRequirements = z.infer<typeof BytePaymentRequirementsSchema>;

/** What a payer sends back once it has paid. */
export const BytePaymentPayloadSchema = z.object({
  scheme: z.literal(BYTE_SCHEME),
  network,
  invoiceId,
  txid,
});

export type BytePaymentPayload = z.infer<typeof BytePaymentPayloadSchema>;

/**
 * A payee's private record of an issued invoice.
 *
 * Never sent anywhere. `consumedAt` is what makes replay detection possible, and it is
 * set atomically by the store before the resource is served — see docs/SPEC.md §7.
 */
export interface StoredInvoice {
  invoiceId: string;
  network: (typeof NETWORKS)[number];
  amountZat: string;
  payTo: string;
  memo: string;
  minConfirmations: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  createdAt: number;
  /** Epoch milliseconds, once consumed. Absent while outstanding. */
  consumedAt?: number;
  /** The transaction that settled it, once known. */
  txid?: string;
  /**
   * The locked quote, when this invoice was priced in USD.
   *
   * Stored so the owner API and receipts can report what was charged in dollars, and so a
   * dispute can be settled by pointing at the rate that was actually used rather than
   * whatever the rate is now.
   */
  price?: PriceQuote;
  /** Opaque, caller-defined. Byte neither inspects nor transmits this. */
  metadata?: Record<string, unknown>;
}

/** Parse untrusted payment requirements. Throws `ZodError` on anything malformed. */
export function parsePaymentRequirements(value: unknown): BytePaymentRequirements {
  return BytePaymentRequirementsSchema.parse(value);
}

/** Parse an untrusted payment payload. Throws `ZodError` on anything malformed. */
export function parsePaymentPayload(value: unknown): BytePaymentPayload {
  return BytePaymentPayloadSchema.parse(value);
}

/** True once `expiresAt` has passed. */
export function isExpired(invoice: StoredInvoice, now: number = Date.now()): boolean {
  return now >= invoice.expiresAt;
}

/** True once the invoice has been consumed; a second payment against it is a replay. */
export function isConsumed(invoice: StoredInvoice): boolean {
  return invoice.consumedAt !== undefined;
}
