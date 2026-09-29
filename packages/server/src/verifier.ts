/**
 * Payment verification.
 *
 * Implements the seven conditions of docs/SPEC.md §7, in order, and consumes the invoice
 * atomically before reporting success.
 *
 * The ordering is deliberate. Cheap local checks — is this invoice ours, has it expired,
 * was it already consumed — run before anything that touches a wallet, so a flood of
 * replayed or expired claims cannot be used to hammer the chain data source.
 */

import {
  BytePaymentError,
  isAcceptedPool,
  parseZat,
  timingSafeEqual,
  verifyMemo,
  type InvoiceStore,
  type PaymentReason,
  type StoredInvoice,
} from "@byte-protocol/core";
import type { ReceivedNote, ViewOnlyWallet } from "@byte-protocol/wallet";

export interface VerifierOptions {
  wallet: ViewOnlyWallet;
  store: InvoiceStore;
  secret: Uint8Array;
  now?: () => number;
}

export interface VerificationSuccess {
  ok: true;
  invoice: StoredInvoice;
  /** The output that settled the invoice. */
  note: ReceivedNote;
  txid: string;
}

export interface VerificationFailure {
  ok: false;
  reason: PaymentReason;
  message: string;
  /** Outstanding zatoshis, present only when `reason` is `underpaid`. */
  shortfallZat?: string;
  /** Seconds to wait before retrying, present only when `reason` is `pending`. */
  retryAfterSeconds?: number;
}

export type VerificationResult = VerificationSuccess | VerificationFailure;

/** Suggested retry delay while a payment is unconfirmed: roughly one block. */
export const RETRY_AFTER_SECONDS = 75;

function fail(
  reason: PaymentReason,
  message: string,
  extra: Partial<VerificationFailure> = {},
): VerificationFailure {
  return { ok: false, reason, message, ...extra };
}

export class PaymentVerifier {
  readonly #wallet: ViewOnlyWallet;
  readonly #store: InvoiceStore;
  readonly #secret: Uint8Array;
  readonly #now: () => number;

  constructor(options: VerifierOptions) {
    this.#wallet = options.wallet;
    this.#store = options.store;
    this.#secret = options.secret;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Verify a claim that `txid` settled `invoiceId`.
   *
   * Returns a result rather than throwing. A payment that does not verify is the expected
   * case for this method — it is what the 402 loop is built around — not an exception.
   */
  async verify(invoiceId: string, txid: string): Promise<VerificationResult> {
    const invoice = await this.#store.get(invoiceId);

    // An unknown invoice and a consumed one are both reported as `invalid_payment` and
    // `replay` respectively, and neither reveals whether some *other* invoice exists.
    if (invoice === undefined) {
      return fail("invalid_payment", "unknown invoice");
    }
    if (invoice.consumedAt !== undefined) {
      return fail("replay", "this invoice has already been paid");
    }
    if (this.#now() >= invoice.expiresAt) {
      return fail("expired", "this invoice has expired");
    }
    if (!timingSafeEqual(invoice.network, this.#wallet.network)) {
      return fail("invalid_payment", "invoice is for a different network");
    }

    const outputs = await this.#wallet.findOutputs(txid);
    if (outputs.length === 0) {
      // Not seen is not the same as not paid. The payer may have broadcast a moment ago,
      // or the wallet may be a block behind.
      return fail("pending", "transaction not seen yet", {
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      });
    }

    // Find the output that actually settles this invoice. The memo binding is what ties a
    // note to an invoice: it commits to invoiceId, amount and payTo under a secret only
    // this payee holds, so an output whose memo verifies is one we issued.
    const settling = outputs.find((note) =>
      note.memo !== undefined &&
      verifyMemo(this.#secret, note.memo, {
        invoiceId: invoice.invoiceId,
        amountZat: invoice.amountZat,
        payTo: invoice.payTo,
      }),
    );

    if (settling === undefined) {
      return this.#explainNoMatch(outputs, invoice);
    }

    // When the backend can report the destination, check it. byte-walletd cannot, so this
    // is a bonus check rather than the primary one — see docs/SECURITY.md §5.6.
    if (settling.payTo !== undefined && !timingSafeEqual(settling.payTo, invoice.payTo)) {
      return fail("invalid_payment", "payment arrived at a different address");
    }

    if (!isAcceptedPool(settling.pool)) {
      return fail(
        "invalid_payment",
        `payment arrived in the ${settling.pool} pool; Byte accepts ironwood only`,
      );
    }

    const paid = parseZat(settling.valueZat);
    const owed = parseZat(invoice.amountZat);
    if (paid < owed) {
      return fail("underpaid", `paid ${paid} of ${owed} zatoshis`, {
        shortfallZat: (owed - paid).toString(10),
      });
    }

    if (settling.confirmations < invoice.minConfirmations) {
      return fail(
        "pending",
        `${settling.confirmations} of ${invoice.minConfirmations} confirmations`,
        { retryAfterSeconds: RETRY_AFTER_SECONDS },
      );
    }

    // Consume before reporting success. Doing it after — or checking here and writing
    // later — leaves a window in which two concurrent claims both pass and both get
    // served for one payment.
    const consumed = await this.#store.consume(invoice.invoiceId, txid, this.#now());
    if (!consumed) {
      return fail("replay", "this invoice was paid concurrently");
    }

    const settled = await this.#store.get(invoice.invoiceId);
    return { ok: true, invoice: settled ?? invoice, note: settling, txid };
  }

  /**
   * Explain why none of a transaction's outputs settled this invoice.
   *
   * Worth the effort: "invalid_payment" alone leaves an operator with a transaction that
   * plainly exists and no idea why it was refused. The common causes are a payment in the
   * wrong pool and a payment with no memo, and both are worth naming.
   */
  #explainNoMatch(outputs: ReceivedNote[], invoice: StoredInvoice): VerificationFailure {
    const wrongPool = outputs.find((n) => !isAcceptedPool(n.pool));
    if (wrongPool !== undefined && outputs.every((n) => !isAcceptedPool(n.pool))) {
      return fail(
        "invalid_payment",
        `payment arrived in the ${wrongPool.pool} pool; Byte accepts ironwood only`,
      );
    }
    if (outputs.every((n) => n.memo === undefined)) {
      return fail("invalid_payment", "payment carried no memo, so it binds to no invoice");
    }
    return fail(
      "invalid_payment",
      `no output in this transaction carries a memo binding it to invoice ${invoice.invoiceId}`,
    );
  }
}

/** Convert a failure into the error type the client surfaces. */
export function toPaymentError(failure: VerificationFailure): BytePaymentError {
  return new BytePaymentError(failure.reason, failure.message, failure.shortfallZat);
}
