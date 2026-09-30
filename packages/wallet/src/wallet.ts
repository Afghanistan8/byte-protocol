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
  ShieldRequest,
  ShieldResult,
  UnshieldRequest,
  UnshieldResult,
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

/**
 * A wallet that can also move value across the transparent boundary.
 *
 * Separate from `SpendingWallet` on purpose. Most of Byte never needs to shield or
 * unshield — the payer and the payee both work entirely inside Ironwood — and a component
 * that cannot unshield cannot accidentally publish an amount. An agent's payment path
 * should be handed a `SpendingWallet`; only the treasury path needs this.
 */
export interface ShieldingWallet extends SpendingWallet {
  /**
   * Mint a fresh transparent address that this wallet will track.
   *
   * **A fresh one every call.** A rail that delivers ZEC to a transparent address publishes
   * that delivery, and reusing one address across fundings hands an observer the whole
   * funding history for free: every deposit to it is visibly the same party. A new address
   * per quote does not make a delivery private, but it stops each one being labelled as
   * belonging to the last.
   *
   * Implementations MUST register the address with the wallet, so that it looks for
   * unspent outputs there. An address that was minted but never tracked would receive
   * value the wallet could not see, and could not shield.
   */
  newTransparentAddress(): Promise<string>;

  /**
   * Sweep transparent value into Ironwood.
   *
   * Implementations MUST compute the ZIP-317 fee from the built proposal rather than
   * assuming a conventional value, MUST direct the shielded output to Ironwood, and MUST
   * report every transaction they broadcast, including when a split partially succeeds —
   * a caller that is told "it failed" while three of five transactions went out has been
   * told something false.
   */
  shield(request?: ShieldRequest): Promise<ShieldResult>;

  /**
   * Send value out of Ironwood to a transparent address.
   *
   * Implementations MUST reject a shielded or unified destination: this operation exists
   * to leave the shielded pool, and silently accepting a shielded address would make the
   * caller think they had unshielded when they had not.
   */
  unshield(request: UnshieldRequest): Promise<UnshieldResult>;
}

/** True when a wallet can spend. Useful for asserting a facilitator was given view-only. */
export function canSpend(wallet: ViewOnlyWallet): wallet is SpendingWallet {
  return typeof (wallet as SpendingWallet).send === "function";
}

/** True when a wallet can cross the transparent boundary in either direction. */
export function canShield(wallet: ViewOnlyWallet): wallet is ShieldingWallet {
  const w = wallet as ShieldingWallet;
  return typeof w.shield === "function" && typeof w.unshield === "function";
}
