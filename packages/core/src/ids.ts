/**
 * Invoice identifiers.
 *
 * 128 bits from the platform CSPRNG, rendered as 32 lowercase hex characters. Identifiers
 * must be unguessable, not merely unique: an invoice ID is half of what a memo commits
 * to, and a predictable one lets someone construct a memo for an invoice they were never
 * issued.
 */

import { bytesToHex, isHex, randomBytes } from "./bytes.js";
import { INVOICE_ID_BYTES } from "./memo.js";

export function newInvoiceId(): string {
  return bytesToHex(randomBytes(INVOICE_ID_BYTES));
}

export function isInvoiceId(value: unknown): value is string {
  return isHex(value, INVOICE_ID_BYTES);
}

/**
 * Generate a memo secret.
 *
 * Provided so operators do not invent their own. In production the secret comes from the
 * environment and is never generated at runtime — a secret that changes on restart
 * invalidates every outstanding invoice.
 */
export function newMemoSecret(): Uint8Array {
  return randomBytes(32);
}
