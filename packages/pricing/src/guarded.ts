/**
 * The guarded price source.
 *
 * A price feed is the one input to Byte that an attacker can move without touching Zcash
 * at all. Nothing on the chain is wrong if a merchant is convinced ZEC is worth $2 instead
 * of $200 — the invoice is simply for a hundredth of what it should be, and it settles
 * perfectly. So the guards here are not hygiene, they are the control.
 *
 * Three of them, and each fails **closed**:
 *
 * 1. **Staleness.** A price older than `maxPriceAgeSec` is refused. A frozen feed is the
 *    cheapest attack there is: it needs no forgery, only for the attacker to stop the
 *    updates and wait for the market to move.
 * 2. **Deviation.** With two sources, a disagreement beyond `maxDeviationBps` refuses to
 *    invoice at all. It does not average them and it does not pick the cheaper: if two
 *    independent venues disagree by more than a configured margin, *something is wrong*,
 *    and the honest answer is to decline to quote rather than to quote confidently from
 *    the middle of a contradiction.
 * 3. **Sanity.** A non-finite or non-positive rate never reaches the arithmetic.
 *
 * Refusing to invoice costs a merchant one sale. Invoicing at a manipulated rate costs
 * them the difference, silently, on every sale until someone notices.
 */

import {
  ByteProtocolError,
  type PriceSource,
  type ZecUsdPrice,
} from "@byte-protocol/core";

export interface GuardedPriceOptions {
  /**
   * The source whose price is used when everything agrees.
   *
   * Prefer a timestamped source here. Its `at` is what staleness is judged on, and an
   * untimestamped source cannot tell you it has gone stale.
   */
  primary: PriceSource;
  /**
   * An independent second source, cross-checked against the primary.
   *
   * Optional, and its absence is reported rather than hidden: `crossChecked` on the result
   * is false, and a deployment that requires two sources can assert on it.
   */
  secondary?: PriceSource;
  /** Refuse a price older than this. Defaults to 120 seconds. */
  maxPriceAgeSec?: number;
  /** Refuse when two sources differ by more than this. Defaults to 200 bps (2%). */
  maxDeviationBps?: number;
  /**
   * Treat an untimestamped primary as stale immediately. Defaults to false.
   *
   * Turning this on means only a source that reports publication time may price an
   * invoice. Correct for anything valuable; too strict for a testnet demo.
   */
  requireTimestamps?: boolean;
  now?: () => number;
}

export interface GuardedPrice extends ZecUsdPrice {
  /** True when a second source agreed within the deviation limit. */
  crossChecked: boolean;
  /** How far the two sources differed, in basis points. Absent without a secondary. */
  deviationBps?: number;
  /** Every source consulted, for the owner API's price-source health view. */
  observations: ZecUsdPrice[];
}

/** Thrown when no price may be trusted. Never swallowed into a default. */
export class PriceUnavailableError extends ByteProtocolError {}

const DEFAULT_MAX_AGE_SEC = 120;
const DEFAULT_MAX_DEVIATION_BPS = 200;

/** Difference between two rates, in basis points of the smaller one. */
export function deviationBps(a: number, b: number): number {
  const base = Math.min(a, b);
  if (base <= 0) return Number.POSITIVE_INFINITY;
  return Math.round((Math.abs(a - b) / base) * 10_000);
}

export class GuardedPriceSource implements PriceSource {
  readonly sourceId: string;
  readonly #primary: PriceSource;
  readonly #secondary: PriceSource | undefined;
  readonly #maxAgeMs: number;
  readonly #maxDeviationBps: number;
  readonly #requireTimestamps: boolean;
  readonly #now: () => number;

  constructor(options: GuardedPriceOptions) {
    const maxAgeSec = options.maxPriceAgeSec ?? DEFAULT_MAX_AGE_SEC;
    if (!Number.isFinite(maxAgeSec) || maxAgeSec <= 0) {
      throw new ByteProtocolError("maxPriceAgeSec must be a positive number of seconds");
    }
    const maxDeviation = options.maxDeviationBps ?? DEFAULT_MAX_DEVIATION_BPS;
    if (!Number.isInteger(maxDeviation) || maxDeviation < 0) {
      throw new ByteProtocolError("maxDeviationBps must be a non-negative integer");
    }

    this.#primary = options.primary;
    this.#secondary = options.secondary;
    this.#maxAgeMs = maxAgeSec * 1000;
    this.#maxDeviationBps = maxDeviation;
    this.#requireTimestamps = options.requireTimestamps ?? false;
    this.#now = options.now ?? Date.now;
    this.sourceId =
      options.secondary === undefined
        ? options.primary.sourceId
        : `${options.primary.sourceId}+${options.secondary.sourceId}`;
  }

  /** The guarded rate, or a throw. There is no fallback value by design. */
  async getZecUsd(): Promise<GuardedPrice> {
    // Both sources are consulted concurrently: a slow secondary should not add its latency
    // to every invoice, and both have their own timeout.
    const [primary, secondary] = await Promise.all([
      this.#primary.getZecUsd().catch((cause: unknown) => {
        throw new PriceUnavailableError(
          `primary price source ${this.#primary.sourceId} failed`,
          { cause },
        );
      }),
      this.#secondary === undefined
        ? Promise.resolve(undefined)
        : this.#secondary.getZecUsd().catch((cause: unknown) => {
            // A secondary that is merely down must not be treated as agreement. It is
            // reported as a failed cross-check, and `assertCrossChecked` below is how a
            // deployment that requires two sources refuses to proceed.
            throw new PriceUnavailableError(
              `secondary price source ${this.#secondary?.sourceId} failed, so this price ` +
                `cannot be cross-checked`,
              { cause },
            );
          }),
    ]);

    const observations = secondary === undefined ? [primary] : [primary, secondary];

    this.#assertSane(primary);
    this.#assertFresh(primary);

    if (secondary === undefined) {
      return { ...primary, crossChecked: false, observations };
    }

    this.#assertSane(secondary);
    this.#assertFresh(secondary);

    const bps = deviationBps(primary.price, secondary.price);
    if (bps > this.#maxDeviationBps) {
      throw new PriceUnavailableError(
        `${this.#primary.sourceId} says ${primary.price} and ${this.#secondary?.sourceId} ` +
          `says ${secondary.price}, a difference of ${bps} bps, over the limit of ` +
          `${this.#maxDeviationBps}. Refusing to invoice rather than guess which is right.`,
      );
    }

    return { ...primary, crossChecked: true, deviationBps: bps, observations };
  }

  #assertSane(observation: ZecUsdPrice): void {
    if (!Number.isFinite(observation.price) || observation.price <= 0) {
      throw new PriceUnavailableError(
        `${observation.source} reported ${observation.price} USD per ZEC, which is not a price`,
      );
    }
  }

  #assertFresh(observation: ZecUsdPrice): void {
    if (!observation.timestamped) {
      if (this.#requireTimestamps) {
        throw new PriceUnavailableError(
          `${observation.source} reports no publication time, and requireTimestamps is on. ` +
            `An untimestamped feed cannot tell you it has gone stale.`,
        );
      }
      // Without a publication time there is nothing to age. Byte says so rather than
      // pretending the fetch time proves freshness.
      return;
    }

    const age = this.#now() - observation.at;
    if (age > this.#maxAgeMs) {
      throw new PriceUnavailableError(
        `${observation.source} last published ${Math.round(age / 1000)}s ago, over the ` +
          `${Math.round(this.#maxAgeMs / 1000)}s limit. A frozen feed is the cheapest way ` +
          `to make a merchant under-charge.`,
      );
    }
    if (age < -this.#maxAgeMs) {
      // A price from the future means a clock is wrong somewhere, and a wrong clock makes
      // every staleness check meaningless.
      throw new PriceUnavailableError(
        `${observation.source} published ${Math.round(-age / 1000)}s in the future; ` +
          `a clock is wrong and staleness cannot be judged`,
      );
    }
  }
}

/** Throw unless a price was confirmed by a second, independent source. */
export function assertCrossChecked(price: GuardedPrice): void {
  if (!price.crossChecked) {
    throw new PriceUnavailableError(
      "this price was not cross-checked against a second source; configure `secondary`",
    );
  }
}
