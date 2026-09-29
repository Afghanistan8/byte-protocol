/**
 * Failure reasons and error types.
 *
 * The reason codes here are the single source of truth. docs/SPEC.md §8 describes the
 * same set, and nothing else in the repository invents a code that is not listed here.
 */

/** Reasons a payee or facilitator refuses to serve. Sent on the wire. */
export const PAYMENT_REASONS = [
  /** Paid, but for less than the invoice asked. The shortfall is reported. */
  "underpaid",
  /** The invoice's `expiresAt` has passed. A fresh invoice is issued alongside. */
  "expired",
  /** Not seen yet, or seen with too few confirmations. Retry later. */
  "pending",
  /** This invoice was already consumed. */
  "replay",
  /** Wrong pool, wrong address, or the memo binding did not match. */
  "invalid_payment",
] as const;

export type PaymentReason = (typeof PAYMENT_REASONS)[number];

/** Reasons a payer refuses to build a transaction. Never sent on the wire. */
export const PAYER_REASONS = [
  /**
   * The wallet would have had to spend from a transparent source or from the sealed
   * Orchard pool. Crossing pools reveals the net amount on-chain (ZIP 318), which
   * defeats the guarantee Byte exists to provide, so Byte refuses rather than falling
   * back silently.
   */
  "wrong_pool_source",
  /** The spend guard denied the payment. */
  "guard_denied",
  /** The wallet does not hold enough spendable Ironwood value. */
  "insufficient_funds",
] as const;

export type PayerReason = (typeof PAYER_REASONS)[number];

/** Base class for every error Byte raises deliberately. */
export class ByteError extends Error {
  override readonly name: string = "ByteError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The peer sent something that does not conform to the spec. */
export class ByteProtocolError extends ByteError {
  override readonly name = "ByteProtocolError";
}

/** A memo could not be encoded, parsed, or did not bind to the invoice. */
export class ByteMemoError extends ByteError {
  override readonly name = "ByteMemoError";
}

/** Verification concluded the payment is not acceptable. */
export class BytePaymentError extends ByteError {
  override readonly name = "BytePaymentError";
  readonly reason: PaymentReason;
  /** Outstanding zatoshis, present only when `reason` is `underpaid`. */
  readonly shortfallZat?: string;

  constructor(reason: PaymentReason, message: string, shortfallZat?: string) {
    super(message);
    this.reason = reason;
    if (shortfallZat !== undefined) this.shortfallZat = shortfallZat;
  }
}

/** The payer declined to build a transaction. No transaction was broadcast. */
export class BytePayerError extends ByteError {
  override readonly name = "BytePayerError";
  readonly reason: PayerReason;

  constructor(reason: PayerReason, message: string) {
    super(message);
    this.reason = reason;
  }
}
