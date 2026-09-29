/**
 * Byte receipts.
 *
 * A receipt is an Ed25519 signature by the payee over the facts of a settled payment. It
 * is the unit of *selective disclosure*: nothing about a Byte payment is visible by
 * default, so an agent that must later prove it was paid — to an auditor, a counterparty,
 * a reputation system — hands over receipts for the specific payments in question, rather
 * than surrendering a viewing key that would expose everything.
 *
 * See docs/SPEC.md §9.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes, isHex, utf8ToBytes } from "./bytes.js";
import { ByteProtocolError } from "./errors.js";
import type { ByteNetwork } from "./network.js";

/**
 * Domain separator.
 *
 * Without one, a signature over a receipt could be presented as a signature over some
 * other Byte structure that happened to serialize identically. Every signing context in
 * Byte commits to its own tag.
 */
/**
 * Bumped from `v1` when receipts learned to carry the USD side of a priced invoice.
 *
 * The version is in the signed bytes, so a v1 signature cannot be replayed as a v2
 * receipt and vice versa. That matters more than it looks: v2 appends two fields, and
 * without a domain bump a v1 receipt would verify as a v2 receipt whose price fields
 * happened to be empty — letting someone present an unpriced receipt as proof about a
 * priced invoice.
 */
export const RECEIPT_DOMAIN = "byte-receipt-v2";

export interface ReceiptBody {
  invoiceId: string;
  txid: string;
  /** Zatoshis, canonical integer string. */
  amount: string;
  payTo: string;
  network: ByteNetwork;
  /** RFC 3339 UTC, when the payee accepted the payment. */
  timestamp: string;
  /**
   * What the merchant charged in USD, when the invoice was priced in USD.
   *
   * Settlement happened in ZEC — `amount` is the fact, this is the denomination. Both are
   * signed, so a receipt cannot be presented with one of them altered.
   */
  priceUsd?: string;
  /** The USD-per-ZEC rate the invoice was locked at. */
  zecUsd?: number;
}

export interface ByteReceipt extends ReceiptBody {
  /** Ed25519 public key of the issuing payee, 32 bytes, lowercase hex. */
  issuer: string;
  /** Ed25519 signature over the canonical body, 64 bytes, lowercase hex. */
  signature: string;
}

/**
 * Canonical serialization.
 *
 * Fields in a fixed order, joined by `\u0000`, under a domain tag. Deliberately not
 * `JSON.stringify`: JSON key order is an implementation detail, whitespace is optional,
 * and string escaping varies between engines — none of which a verifier can rely on
 * reproducing byte-for-byte. A signature is only meaningful over bytes both sides agree
 * on exactly.
 */
export function canonicalReceiptBytes(body: ReceiptBody): Uint8Array {
  const fields = [
    RECEIPT_DOMAIN,
    body.invoiceId,
    body.txid,
    body.amount,
    body.payTo,
    body.network,
    body.timestamp,
    // Always present in the signed bytes, empty when the invoice was not priced in USD.
    // Omitting an absent field instead would let two different receipts serialize
    // identically, which is the field-boundary collision the null separator exists to
    // prevent in the first place.
    body.priceUsd ?? "",
    body.zecUsd === undefined ? "" : String(body.zecUsd),
  ];
  for (const field of fields) {
    if (field.includes("\u0000")) {
      throw new ByteProtocolError("receipt fields must not contain a null byte");
    }
  }
  return utf8ToBytes(fields.join("\u0000"));
}

/** Generate an Ed25519 signing key. The secret is 32 bytes; keep it out of logs. */
export function newSigningKey(): { secretKey: Uint8Array; publicKey: string } {
  const secretKey = ed25519.utils.randomSecretKey();
  return { secretKey, publicKey: bytesToHex(ed25519.getPublicKey(secretKey)) };
}

/** Derive the public key, as lowercase hex, from a secret key. */
export function publicKeyOf(secretKey: Uint8Array): string {
  return bytesToHex(ed25519.getPublicKey(secretKey));
}

/** Sign a receipt body. */
export function signReceipt(secretKey: Uint8Array, body: ReceiptBody): ByteReceipt {
  const signature = ed25519.sign(canonicalReceiptBytes(body), secretKey);
  return {
    ...body,
    issuer: publicKeyOf(secretKey),
    signature: bytesToHex(signature),
  };
}

/**
 * Verify a receipt.
 *
 * Returns a boolean, never throws. A receipt arrives from whoever is presenting it, so
 * malformed input is the expected case, not an exceptional one.
 *
 * This proves only that the holder of `issuer`'s key attested to these facts. It does not
 * prove the transaction exists — only a node can say that — and it does not prove
 * `issuer` is anyone in particular. Bind the issuer key to an identity through an Agent
 * Card before trusting what a receipt says.
 */
export function verifyReceipt(receipt: unknown, expectedIssuer?: string): boolean {
  if (typeof receipt !== "object" || receipt === null) return false;
  const r = receipt as Partial<ByteReceipt>;

  if (!isHex(r.issuer, 32) || !isHex(r.signature, 64)) return false;
  if (expectedIssuer !== undefined && r.issuer !== expectedIssuer) return false;

  for (const key of ["invoiceId", "txid", "amount", "payTo", "network", "timestamp"] as const) {
    if (typeof r[key] !== "string") return false;
  }
  if (r.priceUsd !== undefined && typeof r.priceUsd !== "string") return false;
  if (r.zecUsd !== undefined && typeof r.zecUsd !== "number") return false;

  try {
    return ed25519.verify(
      hexToBytes(r.signature as string),
      canonicalReceiptBytes(r as ReceiptBody),
      hexToBytes(r.issuer as string),
    );
  } catch {
    return false;
  }
}

/**
 * Build a receipt body from a settled invoice.
 *
 * Carries the USD denomination across automatically when the invoice had one. Left to
 * each caller, the price fields are exactly the sort of thing that gets forgotten on one
 * code path and then quietly missing from half the receipts.
 */
export function receiptBodyFor(
  invoice: {
    invoiceId: string;
    amountZat: string;
    payTo: string;
    network: ByteNetwork;
    price?: { priceUsd: string; zecUsd: number };
  },
  txid: string,
  at: number = Date.now(),
): ReceiptBody {
  return {
    invoiceId: invoice.invoiceId,
    txid,
    amount: invoice.amountZat,
    payTo: invoice.payTo,
    network: invoice.network,
    timestamp: new Date(at).toISOString(),
    ...(invoice.price !== undefined
      ? { priceUsd: invoice.price.priceUsd, zecUsd: invoice.price.zecUsd }
      : {}),
  };
}
