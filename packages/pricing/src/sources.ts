/**
 * ZEC/USD price sources.
 *
 * Two real ones and a deterministic mock. Both real sources are public, documented and
 * need no key — a payment library that demands a signup before it can issue an invoice is
 * a payment library nobody runs.
 */

import { ByteProtocolError, type PriceSource, type ZecUsdPrice } from "@byte-protocol/core";

const DEFAULT_TIMEOUT_MS = 8_000;

/** Fetch JSON with a timeout and a size cap, or throw with the source named. */
async function getJson(
  url: string,
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number; sourceId: string },
): Promise<unknown> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await doFetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    throw new ByteProtocolError(`${options.sourceId}: could not reach ${url}`, { cause });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new ByteProtocolError(
      `${options.sourceId}: ${url} returned ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ByteProtocolError(`${options.sourceId}: ${url} did not return JSON`, { cause });
  }
}

/**
 * NEAR Intents, via the 1Click token list.
 *
 * `GET /v0/tokens` carries a `price` and a `priceUpdatedAt` for every listed asset, so
 * this is a *timestamped* source: `at` is when the price was actually published, not when
 * Byte asked. That is what makes `maxPriceAgeSec` mean something.
 *
 * Byte already speaks to this service for the funding rail, so using it for pricing adds
 * no new third party to trust.
 */
export class NearIntentsPriceSource implements PriceSource {
  readonly sourceId = "near-intents";
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #timeoutMs: number | undefined;

  constructor(
    options: {
      baseUrl?: string;
      fetch?: typeof globalThis.fetch;
      timeoutMs?: number;
    } = {},
  ) {
    this.#baseUrl = options.baseUrl ?? "https://1click.chaindefuser.com/v0";
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
  }

  async getZecUsd(): Promise<ZecUsdPrice> {
    const tokens = (await getJson(`${this.#baseUrl}/tokens`, {
      sourceId: this.sourceId,
      ...(this.#fetch !== undefined ? { fetch: this.#fetch } : {}),
      ...(this.#timeoutMs !== undefined ? { timeoutMs: this.#timeoutMs } : {}),
    })) as Array<{
      symbol?: string;
      blockchain?: string;
      price?: number;
      priceUpdatedAt?: string;
    }>;

    if (!Array.isArray(tokens)) {
      throw new ByteProtocolError(`${this.sourceId}: /tokens did not return a list`);
    }

    // Match on the native ZEC entry, not merely the symbol: the same symbol can appear as
    // a bridged representation on another chain, and its price is not necessarily ZEC's.
    const zec = tokens.find(
      (t) => t.symbol?.toUpperCase() === "ZEC" && t.blockchain?.toLowerCase() === "zec",
    );
    if (zec === undefined) {
      throw new ByteProtocolError(`${this.sourceId}: no native ZEC entry in /tokens`);
    }
    if (typeof zec.price !== "number" || !Number.isFinite(zec.price) || zec.price <= 0) {
      throw new ByteProtocolError(
        `${this.sourceId}: ZEC entry has no usable price (${JSON.stringify(zec.price)})`,
      );
    }

    const published = zec.priceUpdatedAt !== undefined ? Date.parse(zec.priceUpdatedAt) : NaN;
    const timestamped = Number.isFinite(published);

    return {
      price: zec.price,
      source: this.sourceId,
      at: timestamped ? published : Date.now(),
      timestamped,
    };
  }
}

/**
 * Kraken's public ticker.
 *
 * No key, no signup, no rate-limit negotiation — `GET /0/public/Ticker?pair=ZECUSD`. An
 * independent source with real exchange volume behind it, which is the point: two sources
 * that both read a third aggregator would agree while being wrong together.
 *
 * **Untimestamped.** Kraken's ticker reports the last trade but not when it happened, so
 * `at` is when Byte asked and `timestamped` is false. A stale cache behind the endpoint
 * would look fresh, which is exactly why Byte prefers a timestamped source as primary and
 * uses this one to cross-check.
 *
 * The result key is not hardcoded. Kraken pads asset codes to four characters — ZEC/USD is
 * returned as `XZECZUSD`, not `ZECUSD` — and that convention has shifted before, so the
 * single returned entry is taken as the answer.
 */
export class KrakenPriceSource implements PriceSource {
  readonly sourceId = "kraken";
  readonly #baseUrl: string;
  readonly #pair: string;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #timeoutMs: number | undefined;

  constructor(
    options: {
      baseUrl?: string;
      /** Kraken pair to request. Defaults to `ZECUSD`. */
      pair?: string;
      fetch?: typeof globalThis.fetch;
      timeoutMs?: number;
    } = {},
  ) {
    this.#baseUrl = options.baseUrl ?? "https://api.kraken.com";
    this.#pair = options.pair ?? "ZECUSD";
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
  }

  async getZecUsd(): Promise<ZecUsdPrice> {
    const body = (await getJson(
      `${this.#baseUrl}/0/public/Ticker?pair=${encodeURIComponent(this.#pair)}`,
      {
        sourceId: this.sourceId,
        ...(this.#fetch !== undefined ? { fetch: this.#fetch } : {}),
        ...(this.#timeoutMs !== undefined ? { timeoutMs: this.#timeoutMs } : {}),
      },
    )) as { error?: unknown[]; result?: Record<string, { c?: unknown }> };

    // Kraken answers 200 with a populated `error` array on a bad pair, so the status code
    // alone does not tell you whether this worked.
    if (Array.isArray(body.error) && body.error.length > 0) {
      throw new ByteProtocolError(`${this.sourceId}: ${JSON.stringify(body.error).slice(0, 200)}`);
    }

    const entries = Object.entries(body.result ?? {});
    if (entries.length !== 1) {
      throw new ByteProtocolError(
        `${this.sourceId}: expected exactly one pair in the result, got ${entries.length}`,
      );
    }

    // `c` is [last trade price, lot volume], both as decimal strings.
    const last = (entries[0]?.[1] as { c?: unknown }).c;
    const raw = Array.isArray(last) ? last[0] : undefined;
    const price = typeof raw === "string" ? Number.parseFloat(raw) : NaN;

    if (!Number.isFinite(price) || price <= 0) {
      throw new ByteProtocolError(
        `${this.sourceId}: last trade price is not a positive number (${JSON.stringify(raw)})`,
      );
    }

    return {
      price,
      source: this.sourceId,
      // Kraken publishes no timestamp on the ticker. Saying so is more useful than
      // pretending this is publication time.
      at: Date.now(),
      timestamped: false,
    };
  }
}

/** A fixed price, for tests and for offline development. */
export class MockPriceSource implements PriceSource {
  readonly sourceId: string;
  #price: number;
  #at: number | undefined;
  #failWith: Error | undefined;

  constructor(price: number, options: { sourceId?: string; at?: number } = {}) {
    this.#price = price;
    this.sourceId = options.sourceId ?? "mock";
    this.#at = options.at;
  }

  /** Move the price, to exercise deviation guards. */
  set(price: number, at?: number): void {
    this.#price = price;
    this.#at = at;
  }

  /** Make the next call throw, to exercise failure handling. */
  fail(error: Error | undefined): void {
    this.#failWith = error;
  }

  async getZecUsd(): Promise<ZecUsdPrice> {
    if (this.#failWith !== undefined) throw this.#failWith;
    return {
      price: this.#price,
      source: this.sourceId,
      at: this.#at ?? Date.now(),
      timestamped: this.#at !== undefined,
    };
  }
}
