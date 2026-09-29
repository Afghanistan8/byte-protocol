import { describe, expect, it } from "vitest";
import {
  MAX_ZATOSHIS,
  ZATOSHIS_PER_ZEC,
  formatZat,
  isZat,
  parseZat,
  zatToZecString,
  zecStringToZat,
} from "./amount.js";
import { ByteProtocolError } from "./errors.js";

describe("parseZat", () => {
  it("accepts canonical integer strings", () => {
    expect(parseZat("0")).toBe(0n);
    expect(parseZat("100000")).toBe(100_000n);
    expect(parseZat(MAX_ZATOSHIS.toString())).toBe(MAX_ZATOSHIS);
  });

  it.each([
    ["leading zero", "0100"],
    ["negative", "-1"],
    ["explicit plus", "+100"],
    ["decimal", "1.5"],
    ["exponent", "1e8"],
    ["whitespace", " 100 "],
    ["hex", "0x64"],
    ["empty", ""],
    ["not a string", 100 as unknown as string],
  ])("rejects %s", (_label, input) => {
    expect(() => parseZat(input)).toThrow(ByteProtocolError);
  });

  it("rejects amounts above the maximum supply", () => {
    expect(() => parseZat((MAX_ZATOSHIS + 1n).toString())).toThrow(/maximum supply/);
  });

  it("handles values beyond Number.MAX_SAFE_INTEGER without loss", () => {
    // 2.1e15 zatoshis is within a factor of 5 of the double-precision safe range. This is
    // the whole reason amounts are strings and bigints rather than numbers.
    const big = "2099999999999999";
    expect(parseZat(big).toString()).toBe(big);
  });
});

describe("isZat", () => {
  it("agrees with parseZat", () => {
    for (const v of ["0", "1", MAX_ZATOSHIS.toString()]) expect(isZat(v)).toBe(true);
    for (const v of ["01", "-1", "1.0", "", "x", (MAX_ZATOSHIS + 1n).toString()]) {
      expect(isZat(v)).toBe(false);
    }
  });

  it("rejects non-strings without throwing", () => {
    for (const v of [null, undefined, 5, {}, []]) expect(isZat(v)).toBe(false);
  });
});

describe("formatZat", () => {
  it("renders the canonical string", () => {
    expect(formatZat(0n)).toBe("0");
    expect(formatZat(100_000n)).toBe("100000");
  });

  it("refuses negative and oversized amounts", () => {
    expect(() => formatZat(-1n)).toThrow(ByteProtocolError);
    expect(() => formatZat(MAX_ZATOSHIS + 1n)).toThrow(ByteProtocolError);
  });
});

describe("ZEC decimal conversion", () => {
  it("renders whole ZEC without a fractional part", () => {
    expect(zatToZecString(ZATOSHIS_PER_ZEC)).toBe("1");
    expect(zatToZecString(0n)).toBe("0");
  });

  it("trims trailing zeroes but keeps significant ones", () => {
    expect(zatToZecString(150_000_000n)).toBe("1.5");
    expect(zatToZecString(100_000n)).toBe("0.001");
    expect(zatToZecString(1n)).toBe("0.00000001");
  });

  it("does not lose precision on values a double cannot hold", () => {
    // 0.1 ZEC is not representable in binary floating point. Doing this with Number
    // would round the payment amount.
    expect(zatToZecString(10_000_000n)).toBe("0.1");
    expect(zecStringToZat("0.1")).toBe(10_000_000n);
  });

  it("round-trips", () => {
    for (const zat of [0n, 1n, 12_345_678n, ZATOSHIS_PER_ZEC, MAX_ZATOSHIS]) {
      expect(zecStringToZat(zatToZecString(zat))).toBe(zat);
    }
  });

  it.each([
    ["more than 8 decimal places", "0.000000001"],
    ["leading zero", "01.0"],
    ["negative", "-1.0"],
    ["trailing dot", "1."],
    ["leading dot", ".5"],
    ["empty", ""],
    ["over supply", "21000001"],
  ])("rejects %s", (_label, input) => {
    expect(() => zecStringToZat(input)).toThrow(ByteProtocolError);
  });
});
