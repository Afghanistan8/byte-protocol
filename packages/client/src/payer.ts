/**
 * The payer.
 *
 * Takes payment requirements, checks them, asks the guard, and settles. Everything that
 * could refuse happens before a transaction is built, so a refusal costs nothing and
 * leaves nothing on-chain.
 */

import {
  BytePayerError,
  ByteProtocolError,
  BYTE_SCHEME,
  parsePaymentRequirements,
  parseZat,
  verifyMemo,
  type BytePaymentPayload,
  type BytePaymentRequirements,
} from "@byte-protocol/core";
import type { SpendingWallet } from "@byte-protocol/wallet";
import { SpendGuard } from "./guard.js";

export interface BytePayerOptions {
  wallet: SpendingWallet;
  guard?: SpendGuard;
  now?: () => number;
}

export class BytePayer {
  readonly #wallet: SpendingWallet;
  readonly #guard: SpendGuard | undefined;
  readonly #now: () => number;

  constructor(options: BytePayerOptions) {
    this.#wallet = options.wallet;
    this.#guard = options.guard;
    this.#now = options.now ?? Date.now;
  }

  get guard(): SpendGuard | undefined {
    return this.#guard;
  }

  /**
   * Settle an invoice and return the payload to retry the request with.
   *
   * `url` is passed for the guard's allowlist and audit log; it is not sent anywhere.
   */
  async pay(
    requirements: unknown,
    url: string,
  ): Promise<{ payload: BytePaymentPayload; txid: string; feeZat: string }> {
    // Parse before trusting. These requirements arrived from a server that may be hostile,
    // or merely broken, and every field below is about to influence where money goes.
    let invoice: BytePaymentRequirements;
    try {
      invoice = parsePaymentRequirements(requirements);
    } catch (cause) {
      throw new ByteProtocolError("payment requirements are malformed", { cause });
    }

    if (invoice.scheme !== BYTE_SCHEME) {
      throw new ByteProtocolError(`unsupported scheme ${invoice.scheme}`);
    }
    if (invoice.network !== this.#wallet.network) {
      // Paying on the wrong network sends real value somewhere it cannot be recovered
      // from, so this is checked before anything else touches the wallet.
      throw new ByteProtocolError(
        `invoice is for ${invoice.network} but this wallet is on ${this.#wallet.network}`,
      );
    }
    if (Date.parse(invoice.expiresAt) <= this.#now()) {
      throw new ByteProtocolError("invoice has already expired");
    }

    // The server tells us both the memo and the fields it should bind to. We cannot verify
    // the binding — only the payee holds that secret — but we can check the memo is
    // well-formed and mentions this invoice, which catches a server that has mixed two
    // invoices up and would otherwise send our money against someone else's.
    assertMemoMatchesInvoice(invoice);

    const amount = parseZat(invoice.amount);
    if (amount === 0n) {
      throw new ByteProtocolError("invoice asks for zero");
    }

    if (this.#guard !== undefined) {
      const decision = await this.#guard.authorize({
        amountZat: invoice.amount,
        url,
        invoiceId: invoice.invoiceId,
      });
      SpendGuard.assertAllowed(decision);
    }

    let result: { txid: string; feeZat: string };
    try {
      result = await this.#wallet.send({
        to: invoice.payTo,
        amountZat: invoice.amount,
        memo: invoice.memo,
      });
    } catch (error) {
      // The payment did not happen, so return the amount to the daily budget. The wallet
      // is responsible for having broadcast nothing on failure; `wrong_pool_source` and
      // `insufficient_funds` both refuse before building anything.
      this.#guard?.refund(invoice.amount);
      throw error;
    }

    return {
      payload: {
        scheme: BYTE_SCHEME,
        network: invoice.network,
        invoiceId: invoice.invoiceId,
        txid: result.txid,
      },
      txid: result.txid,
      feeZat: result.feeZat,
    };
  }
}

/**
 * Check the memo the server handed us actually refers to this invoice.
 *
 * A payer cannot verify the HMAC binding — that needs the payee's secret — but it can
 * check the memo parses and carries this invoice's identifier. A server that hands out
 * invoice A's memo with invoice B's amount would otherwise get a payment that can never
 * verify, and the payer would have spent for nothing.
 */
function assertMemoMatchesInvoice(invoice: BytePaymentRequirements): void {
  // `verifyMemo` with a throwaway secret still performs the structural checks, but the
  // binding comparison would fail, so the identifier is compared directly instead.
  const parts = invoice.memo.split("|");
  if (parts.length !== 3 || parts[0] !== "BYTE1") {
    throw new ByteProtocolError("invoice memo is not a Byte memo");
  }
  if (parts[1] !== invoice.invoiceId) {
    throw new ByteProtocolError(
      "invoice memo refers to a different invoice than the one being paid",
    );
  }
}

/** Re-exported so callers can narrow on payer-side failures without a second import. */
export { BytePayerError, verifyMemo };
