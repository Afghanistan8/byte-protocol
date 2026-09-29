import { describe, expect, it } from "vitest";
import { ByteProtocolError, usdToZat, usdToCents, isUsd, zatToUsd } from "@byte-protocol/core";
import {
  GuardedPriceSource,
  KrakenPriceSource,
  MockPriceSource,
  NearIntentsPriceSource,
  PriceUnavailableError,
  assertCrossChecked,
  deviationBps,
} from "./index.js";

describe("USD parsing", () => {
  it("accepts ordinary prices", () => {
    for (const value of ["0.02", "1", "1.5", "1999.99", "0.01"]) {
      expect(isUsd(value)).toBe(true);
    }
  });

  it("rejects anything that is not exactly a decimal price", () => {
    // Every one of these means someone's encoder is wrong, and coercing it would put a
    // different number on the invoice than the merchant intended.
    for (const value of ["1.234", "+1", "-1", "1e2", ".5", "01", "1.", "", "1,5", " 1"]) {
      expect(isUsd(value), value).toBe(false);
    }
  });

  it("parses to exact cents, not floats", () => {
    expect(usdToCents("0.01")).toBe(1n);
    expect(usdToCents("0.1")).toBe(10n);
    expect(usdToCents("19.99")).toBe(1999n);
    // 0.1 + 0.2 is the canonical float failure; cents make it exact.
    expect(usdToCents("0.1") + usdToCents("0.2")).toBe(usdToCents("0.30"));
  });
});

describe("USD to zatoshis", () => {
  it("converts at a round rate", () => {
    // At $100/ZEC, one dollar is 0.01 ZEC — a million zatoshis.
    expect(usdToZat("1", 100)).toBe("1000000");
    expect(usdToZat("100", 100)).toBe("100000000");
    expect(usdToZat("0.02", 100)).toBe("20000");
  });

  it("rounds up, so a merchant is never systematically underpaid", () => {
    // $0.01 at $3 per ZEC is 333,333.33… zatoshis. Rounding down would shave a zatoshi off
    // every single invoice, always in the payer's favour.
    expect(usdToZat("0.01", 3)).toBe("333334");
  });

  it("refuses a rate that is not a positive finite number", () => {
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => usdToZat("1", rate), String(rate)).toThrow(ByteProtocolError);
    }
  });

  it("refuses a zero-priced invoice", () => {
    expect(() => usdToZat("0", 100)).toThrow(/more than zero/);
  });

  it("refuses an amount beyond the maximum supply", () => {
    // $1bn at a tenth of a cent per ZEC is more ZEC than exists.
    expect(() => usdToZat("1000000000", 0.000001)).toThrow(/maximum supply/);
  });

  it("round-trips back to roughly the same dollars", () => {
    expect(zatToUsd(usdToZat("12.34", 250), 250)).toBe("12.34");
  });
});

describe("deviationBps", () => {
  it("is zero for identical prices", () => {
    expect(deviationBps(200, 200)).toBe(0);
  });

  it("measures against the smaller price, so it cannot be gamed by ordering", () => {
    expect(deviationBps(200, 204)).toBe(deviationBps(204, 200));
    expect(deviationBps(100, 102)).toBe(200);
  });
});

describe("the guarded source", () => {
  const FIXED_NOW = Date.parse("2026-09-29T12:00:00Z");
  const now = () => FIXED_NOW;

  it("returns the primary price when there is no secondary", async () => {
    const guarded = new GuardedPriceSource({
      primary: new MockPriceSource(200, { at: FIXED_NOW }),
      now,
    });
    const price = await guarded.getZecUsd();

    expect(price.price).toBe(200);
    expect(price.crossChecked).toBe(false);
    expect(price.observations).toHaveLength(1);
  });

  it("cross-checks against a second source that agrees", async () => {
    const guarded = new GuardedPriceSource({
      primary: new MockPriceSource(200, { sourceId: "a", at: FIXED_NOW }),
      secondary: new MockPriceSource(201, { sourceId: "b", at: FIXED_NOW }),
      now,
    });
    const price = await guarded.getZecUsd();

    expect(price.crossChecked).toBe(true);
    expect(price.deviationBps).toBe(50);
    // The primary's number is the one used. Averaging two sources would produce a rate
    // neither of them quoted.
    expect(price.price).toBe(200);
    // Both sources are named, so a receipt says what was actually consulted.
    expect(guarded.sourceId).toBe("a+b");
    expect(price.observations.map((o) => o.source)).toEqual(["a", "b"]);
  });

  it("refuses to invoice when two sources disagree", async () => {
    // It does not average them and it does not take the cheaper. If two independent venues
    // disagree by more than the margin, something is wrong, and quoting confidently from
    // the middle of a contradiction is the wrong answer.
    const guarded = new GuardedPriceSource({
      primary: new MockPriceSource(200, { sourceId: "a", at: FIXED_NOW }),
      secondary: new MockPriceSource(150, { sourceId: "b", at: FIXED_NOW }),
      maxDeviationBps: 200,
      now,
    });

    await expect(guarded.getZecUsd()).rejects.toThrow(PriceUnavailableError);
    await expect(guarded.getZecUsd()).rejects.toThrow(/Refusing to invoice/);
  });

  it("refuses a stale price", async () => {
    // A frozen feed is the cheapest attack there is: no forgery, just stop updating and
    // wait for the market to move.
    const guarded = new GuardedPriceSource({
      primary: new MockPriceSource(200, { at: FIXED_NOW - 10 * 60_000 }),
      maxPriceAgeSec: 120,
      now,
    });

    await expect(guarded.getZecUsd()).rejects.toThrow(/600s ago/);
  });

  it("refuses a price from the future, because the clock cannot be trusted", async () => {
    const guarded = new GuardedPriceSource({
      primary: new MockPriceSource(200, { at: FIXED_NOW + 10 * 60_000 }),
      maxPriceAgeSec: 120,
      now,
    });

    await expect(guarded.getZecUsd()).rejects.toThrow(/in the future/);
  });

  it("does not age an untimestamped source, and says so", async () => {
    // Kraken publishes no timestamp. Treating fetch time as publication time would let a
    // stale cache behind the endpoint look permanently fresh.
    const untimestamped = new MockPriceSource(200);
    const guarded = new GuardedPriceSource({ primary: untimestamped, now });

    const price = await guarded.getZecUsd();
    expect(price.timestamped).toBe(false);
  });

  it("can require a timestamped source outright", async () => {
    const guarded = new GuardedPriceSource({
      primary: new MockPriceSource(200),
      requireTimestamps: true,
      now,
    });

    await expect(guarded.getZecUsd()).rejects.toThrow(/cannot tell you it has gone stale/);
  });

  it("refuses a nonsense rate before it reaches the arithmetic", async () => {
    for (const bad of [0, -5, Number.NaN]) {
      const guarded = new GuardedPriceSource({
        primary: new MockPriceSource(bad, { at: FIXED_NOW }),
        now,
      });
      await expect(guarded.getZecUsd(), String(bad)).rejects.toThrow(/is not a price/);
    }
  });

  it("treats a failed secondary as a failed cross-check, not as agreement", async () => {
    // The dangerous shortcut would be to shrug and use the primary. That turns "I could
    // not check" into "I checked and it was fine".
    const secondary = new MockPriceSource(200, { sourceId: "b", at: FIXED_NOW });
    secondary.fail(new Error("upstream down"));

    const guarded = new GuardedPriceSource({
      primary: new MockPriceSource(200, { sourceId: "a", at: FIXED_NOW }),
      secondary,
      now,
    });

    await expect(guarded.getZecUsd()).rejects.toThrow(/cannot be cross-checked/);
  });

  it("reports a failed primary rather than falling back to anything", async () => {
    const primary = new MockPriceSource(200, { at: FIXED_NOW });
    primary.fail(new Error("upstream down"));
    const guarded = new GuardedPriceSource({ primary, now });

    await expect(guarded.getZecUsd()).rejects.toThrow(/primary price source/);
  });

  it("assertCrossChecked refuses a single-source price", async () => {
    const guarded = new GuardedPriceSource({
      primary: new MockPriceSource(200, { at: FIXED_NOW }),
      now,
    });
    const price = await guarded.getZecUsd();
    expect(() => assertCrossChecked(price)).toThrow(/not cross-checked/);
  });
});

describe("NearIntentsPriceSource", () => {
  function api(tokens: unknown): typeof globalThis.fetch {
    return async () => Response.json(tokens);
  }

  it("reads the price and its publication time from the native ZEC entry", async () => {
    const source = new NearIntentsPriceSource({
      fetch: api([
        { symbol: "ZEC", blockchain: "eth", price: 1, priceUpdatedAt: "2026-09-29T11:00:00Z" },
        { symbol: "ZEC", blockchain: "zec", price: 231.5, priceUpdatedAt: "2026-09-29T11:59:00Z" },
      ]),
    });

    const price = await source.getZecUsd();
    expect(price.price).toBe(231.5);
    expect(price.timestamped).toBe(true);
    expect(price.at).toBe(Date.parse("2026-09-29T11:59:00Z"));
  });

  it("does not mistake a bridged ZEC on another chain for the real thing", async () => {
    // Same symbol, different asset, different price. Matching on symbol alone would price
    // invoices off whatever wrapper happened to be listed first.
    const source = new NearIntentsPriceSource({
      fetch: api([{ symbol: "ZEC", blockchain: "eth", price: 1, priceUpdatedAt: "2026-09-29T11:59:00Z" }]),
    });
    await expect(source.getZecUsd()).rejects.toThrow(/no native ZEC entry/);
  });

  it("refuses an entry with no usable price", async () => {
    const source = new NearIntentsPriceSource({
      fetch: api([{ symbol: "ZEC", blockchain: "zec", priceUpdatedAt: "2026-09-29T11:59:00Z" }]),
    });
    await expect(source.getZecUsd()).rejects.toThrow(/no usable price/);
  });

  it("falls back to fetch time when the entry carries no publication time", async () => {
    const source = new NearIntentsPriceSource({
      fetch: api([{ symbol: "ZEC", blockchain: "zec", price: 231.5 }]),
    });
    const price = await source.getZecUsd();
    expect(price.timestamped).toBe(false);
  });
});

describe("KrakenPriceSource", () => {
  it("reads the last trade price without hardcoding the pair key", async () => {
    // Kraken pads asset codes to four characters: ZEC/USD comes back as XZECZUSD. Pinning
    // the key would break the day that convention shifts, which it has before.
    const source = new KrakenPriceSource({
      fetch: async () =>
        Response.json({
          error: [],
          result: { XZECZUSD: { c: ["231.50000", "0.42"], v: ["1", "2"] } },
        }),
    });

    const price = await source.getZecUsd();
    expect(price.price).toBe(231.5);
    // Kraken's ticker carries no timestamp, and saying so is more useful than pretending.
    expect(price.timestamped).toBe(false);
  });

  it("treats a populated error array as a failure, despite the 200", async () => {
    // Kraken answers 200 with an error array on a bad pair, so the status code alone does
    // not tell you whether this worked.
    const source = new KrakenPriceSource({
      fetch: async () => Response.json({ error: ["EQuery:Unknown asset pair"], result: {} }),
    });
    await expect(source.getZecUsd()).rejects.toThrow(/Unknown asset pair/);
  });

  it("refuses an ambiguous result with more than one pair", async () => {
    const source = new KrakenPriceSource({
      fetch: async () =>
        Response.json({
          error: [],
          result: { XZECZUSD: { c: ["231.5", "1"] }, XZECZEUR: { c: ["210.0", "1"] } },
        }),
    });
    await expect(source.getZecUsd()).rejects.toThrow(/exactly one pair/);
  });

  it("refuses a malformed last-trade field", async () => {
    const source = new KrakenPriceSource({
      fetch: async () => Response.json({ error: [], result: { XZECZUSD: { c: [] } } }),
    });
    await expect(source.getZecUsd()).rejects.toThrow(/not a positive number/);
  });
});
