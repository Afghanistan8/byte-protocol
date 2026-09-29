/**
 * The funding rail interface.
 *
 * A rail moves value from somewhere else into a Byte wallet. Whatever the source, funds end
 * up **shielded in Ironwood** before Byte will spend them.
 *
 * ## The part every rail has to be honest about
 *
 * A rail that delivers to a transparent Zcash address publishes that leg: the amount, the
 * address and the timing are all on the public chain, and the later shielding transaction
 * reveals the shielding amount too. That is not a Byte limitation to be engineered away —
 * it is what using a transparent address means.
 *
 * So `RailQuote` carries `transparentLeg`, and it is required rather than optional. A rail
 * implementer has to state whether their rail leaks, and a caller can refuse a rail that
 * does. See docs/RAILS.md and docs/SECURITY.md §2.3.
 */

import type { ByteNetwork } from "@byte-protocol/core";

/** Where a rail delivers value, and therefore what it exposes. */
export interface TransparentLeg {
  /**
   * True when value arrives at a transparent Zcash address.
   *
   * Every field of that arrival is public until it is shielded.
   */
  public: boolean;
  /** Why, in a sentence a user could be shown. */
  reason: string;
}

export interface RailQuoteRequest {
  /** Rail-specific source asset identifier. */
  from: string;
  /** Zatoshis of ZEC wanted, canonical integer string. */
  amountOutZat: string;
  /** Where refunds go if the swap fails. Rail-specific. */
  refundTo?: string;
  /** Ask for a quote without committing to anything. */
  dry?: boolean;
}

export interface RailQuote {
  railId: string;
  /**
   * What the funder sends value to.
   *
   * **Absent on a dry quote**, and that is not an error. A dry quote is a price check: no
   * deposit address is reserved because nothing is expected to arrive. 1Click documents
   * exactly this — a dry response omits `depositAddress`, `timeWhenInactive` and
   * `deadline` — and a rail that demanded one would make its own default unusable.
   *
   * A caller that intends to move value asks for `dry: false` and gets an address.
   */
  depositAddress?: string;
  /** Memo the deposit must carry, when the rail requires one. */
  depositMemo?: string;
  /** Amount to send, in the source asset's smallest unit. */
  amountIn: string;
  /** Expected ZEC out, in zatoshis. */
  amountOutZat: string;
  /** RFC 3339 UTC. */
  deadline: string;
  /** Whether this quote is binding or was produced in dry-run. */
  dry: boolean;
  /** What this rail publishes. Required: a rail must state whether it leaks. */
  transparentLeg: TransparentLeg;
  /** Rail-specific extras, for debugging and display. */
  raw?: Record<string, unknown>;
}

/** Normalized rail status. Individual rails map their own states onto these. */
export type RailStatusKind =
  | "awaiting_deposit"
  | "deposit_seen"
  | "processing"
  | "delivered"
  | "incomplete"
  | "refunded"
  | "failed";

export interface RailStatus {
  kind: RailStatusKind;
  /** The rail's own status string, unmapped, so nothing is lost in translation. */
  raw: string;
  /** Delivered amount in zatoshis, once known. */
  amountOutZat?: string;
  /** The destination transaction, once known. */
  destinationTxHash?: string;
  updatedAt?: string;
}

export interface Rail {
  readonly railId: string;
  readonly network: ByteNetwork;
  /** What this rail exposes, independent of any particular quote. */
  readonly transparentLeg: TransparentLeg;

  quote(request: RailQuoteRequest): Promise<RailQuote>;
  status(depositAddress: string): Promise<RailStatus>;
}
