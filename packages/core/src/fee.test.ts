import { describe, expect, it } from "vitest";
import { ByteProtocolError, MAX_FEE_BPS, assertValidFee, feeZatFor } from "./fee.js";

const PAY_TO = "utest1facilitator";

describe("fee terms", () => {
  it("accepts ordinary terms", () => {
    expect(() => assertValidFee({ bps: 100, payTo: PAY_TO })).not.toThrow();
    expect(() => assertValidFee({ bps: 0, payTo: PAY_TO })).not.toThrow();
    expect(() => assertValidFee({ bps: MAX_FEE_BPS, payTo: PAY_TO })).not.toThrow();
  });

  it("refuses a fee over 100%", () => {
    // A payer owing more fee than invoice is always a mistake, never a business model.
    expect(() => assertValidFee({ bps: 10_001, payTo: PAY_TO })).toThrow(/over 100%/);
  });

  it("refuses fractional or negative basis points", () => {
    expect(() => assertValidFee({ bps: 1.5, payTo: PAY_TO })).toThrow(ByteProtocolError);
    expect(() => assertValidFee({ bps: -1, payTo: PAY_TO })).toThrow(ByteProtocolError);
  });

  it("refuses terms with nowhere to pay", () => {
    expect(() => assertValidFee({ bps: 100, payTo: "" })).toThrow(/address to pay to/);
  });
});

describe("feeZatFor", () => {
  it("takes the stated percentage", () => {
    // 1% of 0.1 ZEC.
    expect(feeZatFor("10000000", { bps: 100, payTo: PAY_TO })).toBe("100000");
    expect(feeZatFor("10000000", { bps: 250, payTo: PAY_TO })).toBe("250000");
  });

  it("rounds up, so a facilitator is not short on every invoice", () => {
    // 1% of 1 zatoshi is 0.01 zatoshi. Rounding down means the facilitator absorbs the
    // difference on every small invoice, forever.
    expect(feeZatFor("1", { bps: 100, payTo: PAY_TO })).toBe("1");
    expect(feeZatFor("101", { bps: 100, payTo: PAY_TO })).toBe("2");
  });

  it("applies the floor when the percentage is dust", () => {
    // A percentage of a two-cent payment is below the ZIP 317 marginal fee: it costs more
    // to include the output than the output is worth.
    expect(feeZatFor("1000", { bps: 100, payTo: PAY_TO, minZat: "5000" })).toBe("5000");
    // And the floor does not cap a larger proportional fee.
    expect(feeZatFor("10000000", { bps: 100, payTo: PAY_TO, minZat: "5000" })).toBe("100000");
  });

  it("is zero when the terms come to nothing", () => {
    // Callers read "0" as "no second output" rather than encoding a zero-value output
    // nobody can spend and everyone pays an action fee for.
    expect(feeZatFor("10000000", { bps: 0, payTo: PAY_TO })).toBe("0");
  });

  it("validates the terms before doing arithmetic on them", () => {
    expect(() => feeZatFor("10000000", { bps: 99_999, payTo: PAY_TO })).toThrow(/over 100%/);
  });
});
