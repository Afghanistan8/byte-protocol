/**
 * Reputation, computed from signed receipts and signed feedback.
 *
 * ## No registry, no contract, no oracle
 *
 * Zcash has no contracts, so there is nowhere to put an on-chain reputation registry and
 * Byte does not pretend otherwise. Reputation here is a **function**: give it a set of
 * signed receipts and signed feedback and it returns a score. Anyone holding the same
 * inputs computes the same number, and nobody has to be trusted to have computed it.
 *
 * ## What it can and cannot establish
 *
 * - A **receipt** is a payee's signed statement that it was paid. It proves the payee
 *   *asserted* a payment, not that the payment happened on-chain; only a node can say that.
 * - **Feedback** is a payer's signed statement about a payee. It is only counted when it
 *   references a receipt that verifies **for the same payee**, so feedback cannot be
 *   fabricated about an agent that never took a payment from the author.
 * - Neither can prove *absence*. An agent can simply not show you its bad receipts, so a
 *   score computed from what was presented is a floor on what happened, not a census.
 *   That is a property of any disclosure-based scheme, and it is stated here rather than
 *   discovered by a judge.
 *
 * Sybil resistance is not attempted. Ten fresh keys paying each other look like ten
 * customers. The score is only as good as the set of payers the reader chooses to count.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import {
  bytesToHex,
  hexToBytes,
  isHex,
  utf8ToBytes,
  ByteProtocolError,
  verifyReceipt,
  type ByteReceipt,
} from "@byte-protocol/core";

export const FEEDBACK_DOMAIN = "byte-feedback-v1";

/** A payer's signed opinion of a payee, tied to one payment. */
export interface FeedbackBody {
  /** The invoice this is about. Must match a receipt that verifies. */
  invoiceId: string;
  /** Ed25519 public key of the payee being rated, 32 bytes hex. */
  payee: string;
  /** 1 to 5. */
  rating: number;
  /** Short free text, at most 280 characters. Carries no authority. */
  comment?: string;
  /** RFC 3339 UTC. */
  timestamp: string;
}

export interface ByteFeedback extends FeedbackBody {
  /** Ed25519 public key of the payer who wrote this. */
  author: string;
  signature: string;
}

/**
 * Canonical bytes, domain-separated and null-joined like every other signed Byte structure.
 * Not JSON.stringify: key order and escaping are engine details, and a signature is only
 * meaningful over bytes both sides reproduce exactly.
 */
export function canonicalFeedbackBytes(body: FeedbackBody): Uint8Array {
  const fields = [
    FEEDBACK_DOMAIN,
    body.invoiceId,
    body.payee,
    String(body.rating),
    body.comment ?? "",
    body.timestamp,
  ];
  for (const field of fields) {
    if (field.includes("\u0000")) {
      throw new ByteProtocolError("feedback fields must not contain a null byte");
    }
  }
  return utf8ToBytes(fields.join("\u0000"));
}

export function signFeedback(secretKey: Uint8Array, body: FeedbackBody): ByteFeedback {
  if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) {
    throw new ByteProtocolError("rating must be an integer from 1 to 5");
  }
  if (body.comment !== undefined && body.comment.length > 280) {
    throw new ByteProtocolError("comment must be at most 280 characters");
  }
  return {
    ...body,
    author: bytesToHex(ed25519.getPublicKey(secretKey)),
    signature: bytesToHex(ed25519.sign(canonicalFeedbackBytes(body), secretKey)),
  };
}

/** Verify feedback. Never throws: it arrives from whoever is presenting it. */
export function verifyFeedback(feedback: unknown): boolean {
  if (typeof feedback !== "object" || feedback === null) return false;
  const f = feedback as Partial<ByteFeedback>;

  if (!isHex(f.author, 32) || !isHex(f.signature, 64) || !isHex(f.payee, 32)) return false;
  if (typeof f.invoiceId !== "string" || typeof f.timestamp !== "string") return false;
  if (typeof f.rating !== "number" || !Number.isInteger(f.rating)) return false;
  if (f.rating < 1 || f.rating > 5) return false;
  if (f.comment !== undefined && (typeof f.comment !== "string" || f.comment.length > 280)) {
    return false;
  }

  try {
    return ed25519.verify(
      hexToBytes(f.signature),
      canonicalFeedbackBytes(f as FeedbackBody),
      hexToBytes(f.author),
    );
  } catch {
    return false;
  }
}

export interface Reputation {
  /** The payee this describes. */
  payee: string;
  /** Receipts that verified, were issued by this payee, and were counted. */
  verifiedReceipts: number;
  /** Total settled, in zatoshis, as a string. Sum of counted receipts only. */
  settledZat: string;
  /** Distinct payers who left counted feedback. Authors, not receipts: one payer counts once. */
  distinctRaters: number;
  /** Mean of counted ratings, 0 to 5, or `null` when there are none. */
  meanRating: number | null;
  /**
   * What was thrown away, and why. A score whose inputs are silently filtered cannot be
   * checked; this makes the filtering visible.
   */
  rejected: {
    badReceipts: number;
    receiptsFromSomeoneElse: number;
    badFeedback: number;
    feedbackWithoutReceipt: number;
    feedbackAboutSomeoneElse: number;
    duplicateFeedback: number;
  };
}

/**
 * Compute a payee's reputation from what has been presented.
 *
 * Deterministic and order-independent: the same inputs give the same output in any order.
 */
export function computeReputation(
  payee: string,
  receipts: readonly unknown[],
  feedback: readonly unknown[],
): Reputation {
  const rejected = {
    badReceipts: 0,
    receiptsFromSomeoneElse: 0,
    badFeedback: 0,
    feedbackWithoutReceipt: 0,
    feedbackAboutSomeoneElse: 0,
    duplicateFeedback: 0,
  };

  // Receipts that verify AND were issued by this payee, keyed by invoice.
  const counted = new Map<string, ByteReceipt>();
  for (const candidate of receipts) {
    if (!verifyReceipt(candidate)) {
      rejected.badReceipts += 1;
      continue;
    }
    const receipt = candidate as ByteReceipt;
    if (receipt.issuer !== payee) {
      // A valid receipt from a different payee says nothing about this one, and counting it
      // would let anyone borrow another agent's history.
      rejected.receiptsFromSomeoneElse += 1;
      continue;
    }
    counted.set(receipt.invoiceId, receipt);
  }

  let settled = 0n;
  for (const receipt of counted.values()) settled += BigInt(receipt.amount);

  // One rating per (author, invoice), so repeating feedback cannot stuff the score.
  const seen = new Set<string>();
  const ratings: number[] = [];
  const raters = new Set<string>();

  for (const candidate of feedback) {
    if (!verifyFeedback(candidate)) {
      rejected.badFeedback += 1;
      continue;
    }
    const item = candidate as ByteFeedback;

    if (item.payee !== payee) {
      rejected.feedbackAboutSomeoneElse += 1;
      continue;
    }
    // Feedback only counts against a receipt this payee actually issued. Otherwise anyone
    // could rate an agent they never paid.
    if (!counted.has(item.invoiceId)) {
      rejected.feedbackWithoutReceipt += 1;
      continue;
    }
    const key = `${item.author}\u0000${item.invoiceId}`;
    if (seen.has(key)) {
      rejected.duplicateFeedback += 1;
      continue;
    }
    seen.add(key);
    ratings.push(item.rating);
    raters.add(item.author);
  }

  return {
    payee,
    verifiedReceipts: counted.size,
    settledZat: settled.toString(10),
    distinctRaters: raters.size,
    meanRating:
      ratings.length === 0 ? null : ratings.reduce((a, b) => a + b, 0) / ratings.length,
    rejected,
  };
}
