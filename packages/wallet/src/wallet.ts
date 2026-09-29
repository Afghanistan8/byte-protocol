/**
 * The wallet interfaces.
 *
 * Split along the trust boundary the spec draws (docs/SPEC.md §4). A payee verifying its
 * own invoices, and a facilitator verifying on someone's behalf, need a *view-only*
 * capability. Only a payer needs to spend.
 *
 * The split is the point. A facilitator given a `ViewOnlyWallet` cannot move funds even
 * if it is fully compromised, and that is a property of the type, not of a promise in a
 * README. `SpendingWallet` extends it, so any spending wallet can also verify.
 */

import type { ByteNetwork } from "@byte-protocol/core";
import type {
  ReceivedNote,
  SendRequest,
  SendResult,
  WalletBalance,
  WalletStatus,
} from "./types.js";

/**
 * A wallet backed by a viewing key. Can mint addresses and read payments; cannot spend.
 */
export interface ViewOnlyWallet {
  readonly network: ByteNetwork;

  /**
   * Mint a fresh diversified unified address for one invoice.
   *
   * Implementations MUST derive a new ZIP 32 diversifier per call and MUST NOT return an
   * address they have returned before. Reuse across invoices is what makes two payments
   * linkable on-chain, which is the leak Byte exists to avoid.
   *
   * The address MUST carry an Orchard-typecode receiver and MUST NOT carry a transparent
   * receiver. After NU6.3 that receiver is how value reaches the Ironwood pool; there is
   * no Ironwood receiver type to ask for.
   */
  newInvoiceAddress(): Promise<string>;

  /**
   * Every output this wallet received in the given transaction.
   *
   * Keyed by transaction because that is what the payer reports in its payment payload
   * (docs/SPEC.md section 5.3) and what the underlying wallet API offers.
   *
   * Returns every output found, including ones in pools Byte will not accept. Filtering is
   * the verifier's job: a payment that arrived in the wrong pool must be reported as
   * `invalid_payment`, not silently hidden, or an operator has no way to see what went
   * wrong.
   *
   * An empty array means the wallet received nothing in that transaction — which includes
   * the case where it has never heard of the transaction at all.
   */
  findOutputs(txid: string): Promise<ReceivedNote[]>;

  status(): Promise<WalletStatus>;

  balance(): Promise<WalletBalance>;
}

/** A wallet backed by a spending key. */
export interface SpendingWallet extends ViewOnlyWallet {
  /**
   * Send a shielded Ironwood payment carrying `memo`.
   *
   * Implementations MUST fund the payment from Ironwood notes only. If that is not
   * possible, they MUST throw `BytePayerError` with reason `wrong_pool_source` or
   * `insufficient_funds` and MUST NOT broadcast anything. Falling back to a transparent
   * or Orchard source would publish the amount crossing pools (ZIP 318) and silently
   * break the guarantee the caller asked for.
   */
  send(request: SendRequest): Promise<SendResult>;
}

/** True when a wallet can spend. Useful for asserting a facilitator was given view-only. */
export function canSpend(wallet: ViewOnlyWallet): wallet is SpendingWallet {
  return typeof (wallet as SpendingWallet).send === "function";
}
