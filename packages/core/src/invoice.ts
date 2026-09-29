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

/** The payment requirements a payee sends with a 402. */
export const BytePaymentRequirementsSchema = z.object({
  scheme: z.literal(BYTE_SCHEME),
  network,
  /** Zatoshis. A string, not a number. */
  amount: zatoshis,
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
