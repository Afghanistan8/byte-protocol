/**
 * The optional facilitator fee.
 *
 * ## Byte's protocol fee is zero
 *
 * There is no fee output, no treasury address and nothing to reconcile. "No protocol fee",
 * not "free" — the Zcash network fee still applies and goes to miners.
 *
 * ## What this is, and what enforces it
 *
 * A facilitator verifies payments on a payee's behalf. Some will want to charge for that.
 * So an invoice may carry a **second output** paying the facilitator, encoded in the same
 * ZIP-321 request as the first.
 *
 * **This is enforced by the facilitator's verification, not by the chain.** Zcash has no
 * contracts. Nothing on-chain requires the second output to exist. What happens is:
 *
 * - the facilitator issues an invoice with two outputs;
 * - the payer pays both, because the request says to;
 * - the facilitator checks both arrived before it tells the payee to serve.
 *
 * A payer who skips the facilitator entirely — pays the payee directly and asks the payee
 * to verify — skips the fee. That is not a hole to be plugged; it is what it means to have
 * no contracts. Anyone claiming an on-chain-enforced fee on Zcash is describing something
 * that does not exist, and Byte says so in the same words in README, SPEC and API.md.
 *
 * ## Why basis points and a floor
 *
 * A percentage of a two-cent payment is dust: below the ZIP 317 marginal fee it costs more
 * to include the output than the output is worth. `minZat` is the floor, and a facilitator
 * that sets one below the marginal fee is choosing to lose money on small payments.
 */

import { ByteProtocolError } from "./errors.js";
import { parseZat } from "./amount.js";

/** A facilitator's fee terms. Off by default; absent means no fee. */
export interface FacilitatorFee {
  /** Basis points of the invoice amount. 100 bps = 1%. */
  bps: number;
  /** Floor, in zatoshis. A percentage of a tiny payment is dust. */
  minZat?: string;
  /** A unified address the fee output pays. Never an invoice address. */
  payTo: string;
}

/**
 * The largest fee Byte will encode, in basis points.
 *
 * 10,000 bps is 100%. A configuration above that would ask a payer for more fee than
 * invoice, which is always a mistake rather than a business model, and it fails at
 * construction rather than on a live invoice.
 */
export const MAX_FEE_BPS = 10_000;

export function assertValidFee(fee: FacilitatorFee): void {
  if (!Number.isInteger(fee.bps) || fee.bps < 0) {
    throw new ByteProtocolError(`facilitator fee bps must be a non-negative integer, got ${fee.bps}`);
  }
  if (fee.bps > MAX_FEE_BPS) {
    throw new ByteProtocolError(
      `facilitator fee of ${fee.bps} bps is over 100%; a payer would owe more fee than invoice`,
    );
  }
  if (fee.payTo.length === 0) {
    throw new ByteProtocolError("a facilitator fee needs an address to pay to");
  }
  if (fee.minZat !== undefined) parseZat(fee.minZat);
}

/**
 * The fee due on an invoice, in zatoshis.
 *
 * Rounds **up**. A fee that rounded down would be systematically short on every invoice,
 * always in the payer's favour, and the facilitator would absorb the difference forever.
 * Returns `"0"` when the terms come to nothing, which callers treat as "no second output"
 * rather than encoding a zero-value output nobody can spend.
 */
export function feeZatFor(amountZat: string, fee: FacilitatorFee): string {
  assertValidFee(fee);

  const amount = parseZat(amountZat);
  // Ceiling division on integers: (a*bps + 9999) / 10000.
  const proportional = (amount * BigInt(fee.bps) + 9_999n) / 10_000n;
  const floor = fee.minZat !== undefined ? parseZat(fee.minZat) : 0n;

  const due = proportional > floor ? proportional : floor;
  return due.toString(10);
}
