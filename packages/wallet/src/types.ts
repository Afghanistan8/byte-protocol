/**
 * Wallet vocabulary.
 *
 * These types describe what a Byte wallet backend must be able to report. They are
 * deliberately narrow: Byte needs to mint addresses, send with a memo, and read back
 * received notes with their pool, value, memo and confirmation count. It does not need
 * a general-purpose wallet API, and asking for one would make backends harder to write
 * and easier to get wrong.
 */

import type { ByteNetwork, Pool } from "@byte-protocol/core";

/**
 * A note received at an address Byte controls.
 *
 * `pool` is the field the verifier actually depends on. It reports where the value
 * landed, which the address alone cannot tell you.
 */
export interface ReceivedNote {
  /** Transaction identifier, 64 lowercase hex characters, as the backend reports it. */
  txid: string;
  /** Which pool this note is in. Byte accepts `ironwood` and nothing else. */
  pool: Pool;
  /** Value in zatoshis, canonical integer string. */
  valueZat: string;
  /**
   * The address this note was received at, when the backend can report it.
   *
   * Optional because the real backend cannot. `WalletRead::get_received_outputs` reports
   * an output's pool and value but not its destination address, so `byte-walletd` leaves
   * this unset rather than filling it with a guess. The mock populates it.
   *
   * A verifier therefore establishes the destination through the memo binding, which
   * commits to `invoiceId`, `amount` and `payTo` under the payee's secret, and treats this
   * field as a bonus check when present. See docs/SECURITY.md section 5.6.
   */
  payTo?: string;
  /** Decoded memo text, or undefined when the note carries no text memo. */
  memo?: string;
  /** Confirmations as of the last sync. Zero means seen but unmined. */
  confirmations: number;
  /** Block height, absent while unmined. */
  height?: number;
}

/** What a wallet reports about its own state. */
export interface WalletStatus {
  network: ByteNetwork;
  /** Height the wallet has scanned to. */
  syncedHeight: number;
  /** Chain tip as reported by the light server, when known. */
  chainTip?: number;
  /** True once scanning has caught up with the tip. */
  synced: boolean;
}

/** Balances, split by what can actually be spent right now. */
export interface WalletBalance {
  /** Confirmed Ironwood value that can fund a payment now. */
  spendableZat: string;
  /**
   * Value received but not yet spendable: too few confirmations, or still sitting in a
   * transparent address awaiting auto-shielding. Reported separately because treating it
   * as available is how a wallet promises money it cannot send.
   */
  pendingZat: string;
  /**
   * Value held outside Ironwood — transparent, Sapling, or the sealed Orchard pool.
   * Byte will not spend this. Surfaced so an operator can see it and migrate it, rather
   * than wondering why a balance is unusable.
   */
  unusableZat: string;
}

/** A payment request handed to a spending wallet. */
export interface SendRequest {
  /** Destination unified address. */
  to: string;
  /** Zatoshis, canonical integer string. */
  amountZat: string;
  /** Memo text to attach. Byte always sends one. */
  memo: string;
}

export interface SendResult {
  txid: string;
  /** Fee paid, in zatoshis. */
  feeZat: string;
}

/**
 * Move transparent value into the Ironwood pool.
 *
 * ## What shielding does and does not hide
 *
 * Shielding is a public transaction. Its inputs are transparent UTXOs, visible with their
 * amounts, and the *total* leaving those addresses is therefore public. What becomes
 * private is everything afterwards: once the value is in Ironwood, where it goes next and
 * in what amounts is not observable.
 *
 * So shielding does not retroactively hide a deposit that already happened in public. It
 * ends the exposure; it does not undo it. `splitInto` and `delayRangeSec` make the link
 * between a deposit and its shielding *harder to draw*, not impossible — see
 * docs/RAILS.md, "What a rail cannot fix".
 */
export interface ShieldRequest {
  /**
   * Which transparent addresses to sweep. Every one the wallet controls, when omitted.
   */
  fromTransparent?: string[];
  /**
   * Break the value into this many separate shielding transactions.
   *
   * One deposit becoming one shielding transaction of the same size, minutes later, is
   * trivially linkable by amount. Splitting breaks the amount correlation. It costs one
   * ZIP-317 fee per transaction, which is the trade.
   *
   * Defaults to 1. Values above 1 require the wallet to hold enough to cover each fee.
   */
  splitInto?: number;
  /**
   * Wait a random interval in this range, in seconds, before each transaction.
   *
   * Random, not fixed: a fixed delay is itself a fingerprint. `[0, 0]` shields at once.
   */
  delayRangeSec?: [number, number];
  /**
   * Leave transparent UTXOs below this alone.
   *
   * A UTXO worth less than the fee to shield it costs money to move. Defaults to the
   * conventional ZIP-317 fee, so shielding never loses value on purpose.
   */
  minimumZat?: string;
}

export interface ShieldResult {
  /** One entry per transaction built. */
  transactions: Array<{
    txid: string;
    /** Value shielded by this transaction, in zatoshis, before its fee. */
    amountZat: string;
    /** ZIP-317 fee for this transaction, computed from the proposal, never assumed. */
    feeZat: string;
    /** How long this transaction waited before being broadcast, in seconds. */
    delayedSec: number;
  }>;
  /** Total value that arrived in Ironwood, net of every fee. */
  shieldedZat: string;
  /** Every fee, summed. */
  feeZat: string;
}

/**
 * Move value out of Ironwood to a transparent address.
 *
 * **This is a public transaction, and it publishes the amount.** ZIP 318 is explicit that
 * the net amount crossing between pools is revealed on-chain. Unshielding is how value
 * leaves Byte's guarantee, and there is no version of it that does not leak.
 *
 * It exists because value has to be able to get out — to an exchange, to a rail, to
 * anyone who cannot receive shielded. Byte's position is that it should be a deliberate,
 * separately-named act rather than something `send` does quietly when it runs short.
 */
export interface UnshieldRequest {
  /** A transparent address, `t1` or `t3`. */
  toTransparent: string;
  /** Zatoshis, canonical integer string. */
  amountZat: string;
}

export interface UnshieldResult {
  txid: string;
  feeZat: string;
  /** The amount now public on the chain. Returned so a caller cannot claim surprise. */
  publicAmountZat: string;
}
