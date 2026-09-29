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
