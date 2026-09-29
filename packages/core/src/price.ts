/**
 * USD pricing.
 *
 * ## Why a merchant prices in USD and settles in ZEC
 *
 * A merchant wants to charge two cents for an inference call. They do not want to charge
 * 21,834 zatoshis, because tomorrow that is not two cents. Byte therefore lets an invoice
 * be *denominated* in USD and *settled* in ZEC, converting once at issue time.
 *
 * There is no shielded stablecoin to settle in instead. Zcash has no USDC, and ZSAs are
 * not on mainnet. Anyone claiming otherwise is describing a different chain.
 *
 * ## The quote is locked, and that is the whole design
 *
 * A price is fetched once, written into the invoice, and never consulted again. A payment
 * is judged against `amountZat` alone.
 *
 * The alternative — re-pricing at verification — sounds fairer and is unusable: the payer
 * builds a transaction for one amount, the price moves while it confirms, and the payee
 * decides it is underpaid for a transaction that can no longer be changed. Locking the
 * quote means the payer knows exactly what will settle the invoice at the moment they
 * commit, which is the only property that makes an automated payer safe.
 *
 * The cost of locking is that **both sides carry price risk between the quote and cashing
 * out**. Byte does not hedge that and does not pretend to. Short invoice TTLs are the
 * lever: a five-minute invoice carries five minutes of risk.
 *
 * See docs/SPEC.md §5.6.
 */

import { ByteProtocolError } from "./errors.js";
import { ZATOSHIS_PER_ZEC, MAX_ZATOSHIS } from "./amount.js";

/** A ZEC/USD observation from one source. */
export interface ZecUsdPrice {
  /** USD per ZEC. A number, because this is a market rate, not a ledger amount. */
  price: number;
  /** Which source said so. Free-form, but stable per implementation. */
  source: string;
  /**
   * When the price was true, as epoch milliseconds.
   *
   * **Publication time where a source reports one, observation time where it does not.**
   * The distinction is load-bearing for `maxPriceAgeSec`: NEAR Intents returns
   * `priceUpdatedAt`, so its age is real. Kraken's public ticker reports no timestamp at
   * all, so the best that can honestly be said is when Byte fetched it — a stale cache
   * behind the endpoint would look fresh. `timestamped` says which you are holding.
   */
  at: number;
  /** True when `at` came from the source. False when it is merely when Byte asked. */
  timestamped: boolean;
}

/** Anything that can say what a ZEC is worth. */
export interface PriceSource {
  readonly sourceId: string;
  getZecUsd(): Promise<ZecUsdPrice>;
}

/** The pricing facts locked into an invoice at issue time. */
export interface LockedPrice {
  /** What the merchant asked for, as a decimal string. Never a float. */
  priceUsd: string;
  /** The rate used, USD per ZEC. */
  zecUsd: number;
  /** Which source, or sources, produced it. */
  priceSource: string;
  /** RFC 3339 UTC, when the quote was taken. */
  quotedAt: string;
}

/** Decimal USD with at most two places. Rejects floats, signs and exponents. */
const USD_RE = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;

/**
 * Validate a USD price string.
 *
 * Strings, not numbers, for the same reason amounts are strings: `0.1 + 0.2` is not `0.3`
 * in a double, and a price is about to be multiplied by 10^8.
 */
export function isUsd(value: unknown): value is string {
  return typeof value === "string" && USD_RE.test(value);
}

/** Parse decimal USD into integer cents, exactly. */
export function usdToCents(value: string): bigint {
  const match = USD_RE.exec(value);
  if (match === null) {
    throw new ByteProtocolError(
      `price must be decimal USD with at most two places, got ${JSON.stringify(value)}`,
    );
  }
  const whole = BigInt(match[1] as string);
  const fraction = BigInt((match[2] ?? "").padEnd(2, "0"));
  return whole * 100n + fraction;
}

/**
 * Convert a USD price to zatoshis at a given rate, rounding **up**.
 *
 * Rounding up, not to nearest, and the direction is deliberate. Rounding down would let a
 * merchant asking for $0.02 be settled for one zatoshi less than $0.02 — systematically,
 * on every invoice, in the payer's favour. A payer overpaying by at most one zatoshi is
 * beneath notice; a payee underpaid on every invoice is a slow leak.
 *
 * The arithmetic is done in integers throughout. The rate is the only float involved and
 * it is converted to a scaled integer before it touches an amount.
 */
export function usdToZat(priceUsd: string, zecUsd: number): string {
  if (!Number.isFinite(zecUsd) || zecUsd <= 0) {
    throw new ByteProtocolError(`ZEC/USD rate must be a positive finite number, got ${zecUsd}`);
  }

  const cents = usdToCents(priceUsd);
  if (cents === 0n) {
    throw new ByteProtocolError("a priced invoice must ask for more than zero");
  }

  // Scale the rate to an integer of micro-USD-per-ZEC. Six places is far finer than any
  // exchange quotes ZEC and keeps the product inside bigint comfortably.
  const SCALE = 1_000_000n;
  const rateScaled = BigInt(Math.round(zecUsd * 1_000_000));
  if (rateScaled <= 0n) {
    throw new ByteProtocolError(`ZEC/USD rate ${zecUsd} rounds to zero at six decimal places`);
  }

  // zat = cents/100 USD ÷ (rate USD/ZEC) × 1e8 zat/ZEC, with the division done last.
  const numerator = cents * SCALE * ZATOSHIS_PER_ZEC;
  const denominator = 100n * rateScaled;

  // Ceiling division, on integers.
  const zat = (numerator + denominator - 1n) / denominator;

  if (zat > MAX_ZATOSHIS) {
    throw new ByteProtocolError(
      `$${priceUsd} at ${zecUsd} USD/ZEC is ${zat} zatoshis, over the maximum supply`,
    );
  }
  return zat.toString(10);
}

/** Render zatoshis back to USD at a rate, for display alongside the amount. */
export function zatToUsd(amountZat: string, zecUsd: number): string {
  const zat = BigInt(amountZat);
  const usd = (Number(zat) / Number(ZATOSHIS_PER_ZEC)) * zecUsd;
  return usd.toFixed(2);
}
