import { describe, expect, it } from "vitest";
import { buildZip321, buildZip321Multi, parseZip321Multi, parseZip321 } from "./zip321.js";
import { ByteProtocolError } from "./errors.js";
import { encodeMemo } from "./memo.js";

const address = "utest1exampleaddressexampleaddress";

describe("buildZip321", () => {
  it("emits a zcash: URI with the amount in ZEC, not zatoshis", () => {
    const uri = buildZip321({ address, amountZat: "100000" });
    expect(uri).toBe(`zcash:${address}?amount=0.001`);
  });

  it("base64url-encodes the memo", () => {
    const uri = buildZip321({ address, amountZat: "1", memo: "BYTE1|ab|cd" });
    expect(uri).toContain("memo=QllURTF8YWJ8Y2Q");
    // Unpadded and URL-safe, per RFC 4648 section 5: no "=" padding, no "+" or "/".
    const memoValue = /memo=([^&]*)/.exec(uri)?.[1] ?? "";
    expect(memoValue).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses to build without an address", () => {
    expect(() => buildZip321({ address: "", amountZat: "1" })).toThrow(ByteProtocolError);
  });
});

describe("parseZip321", () => {
  it("round-trips a Byte invoice URI", () => {
    const memo = encodeMemo(new Uint8Array(32).fill(3), {
      invoiceId: "0123456789abcdef0123456789abcdef",
      amountZat: "250000",
      payTo: address,
    });
    const parsed = parseZip321(buildZip321({ address, amountZat: "250000", memo }));
    expect(parsed).toEqual({ address, amountZat: "250000", memo });
  });

  it("round-trips label and message, including characters needing escapes", () => {
    const uri = buildZip321({
      address,
      amountZat: "1",
      label: "Byte & Co (test)",
      message: "thanks! 100% done",
    });
    const parsed = parseZip321(uri);
    expect(parsed.label).toBe("Byte & Co (test)");
    expect(parsed.message).toBe("thanks! 100% done");
  });

  it("rejects the indexed multi-payment form rather than reading only the first leg", () => {
    // Silently parsing one output of a two-output request would underpay.
    expect(() =>
      parseZip321(`zcash:${address}?amount=1&address.1=utest1other&amount.1=2`),
    ).toThrow(/would underpay/);
  });

  it("rejects a req- parameter it does not understand", () => {
    expect(() => parseZip321(`zcash:${address}?amount=1&req-future=x`)).toThrow(
      /unsupported required/,
    );
  });

  it("rejects duplicate parameters", () => {
    expect(() => parseZip321(`zcash:${address}?amount=1&amount=2`)).toThrow(/duplicate/);
  });

  it.each([
    ["a non-zcash URI", "https://example.com"],
    ["a missing amount", `zcash:${address}`],
    ["a missing address", "zcash:?amount=1"],
    ["a non-string", 42 as unknown as string],
  ])("rejects %s", (_label, input) => {
    expect(() => parseZip321(input)).toThrow(ByteProtocolError);
  });

  it("rejects a memo that is not valid base64url", () => {
    expect(() => parseZip321(`zcash:${address}?amount=1&memo=not+base64url!`)).toThrow(
      /base64url/,
    );
  });
});

describe("the indexed multi-payment form", () => {
  const A = "utest1payee";
  const B = "utest1facilitator";

  it("builds one payment identically to the single-payment form", () => {
    // A caller that never uses a fee must see no difference at all.
    const payment = { address: A, amountZat: "1000000", memo: "BYTE1|x|y" };
    expect(buildZip321Multi([payment])).toBe(buildZip321(payment));
  });

  it("puts payment 0's address in the path and the rest in address.N", () => {
    const uri = buildZip321Multi([
      { address: A, amountZat: "1000000" },
      { address: B, amountZat: "10000" },
    ]);

    expect(uri).toBe(`zcash:${A}?amount=0.01&address.1=${B}&amount.1=0.0001`);
  });

  it("round-trips through the parser", () => {
    const payments = [
      { address: A, amountZat: "1000000", memo: "BYTE1|x|y" },
      { address: B, amountZat: "10000" },
    ];
    expect(parseZip321Multi(buildZip321Multi(payments))).toEqual(payments);
  });

  it("never writes a .0 index, which the grammar forbids", () => {
    // paramindex is "." NONZERO 0*3DIGIT, so index 0 has no suffix and .0 is invalid.
    const uri = buildZip321Multi([
      { address: A, amountZat: "1000000" },
      { address: B, amountZat: "10000" },
    ]);
    expect(uri).not.toContain(".0=");
  });

  it("rejects a leading-zero index rather than folding it into index 0", () => {
    // Accepting `amount.01` would silently collide with index 0 and change what gets paid.
    expect(() => parseZip321Multi(`zcash:${A}?amount=1&amount.01=2`)).toThrow(/malformed/);
    expect(() => parseZip321Multi(`zcash:${A}?amount=1&amount.0=2`)).toThrow(/malformed/);
  });

  it("refuses an index carrying an amount but no address", () => {
    // The ZIP requires an address at any index that has other parameters. Without one
    // there is nowhere to send that leg.
    expect(() => parseZip321Multi(`zcash:${A}?amount=1&amount.1=2`)).toThrow(
      /payment\.1 has no address/,
    );
  });

  it("refuses a duplicate parameter at the same index", () => {
    expect(() => parseZip321Multi(`zcash:${A}?amount=1&amount=2`)).toThrow(/duplicate/);
    expect(() =>
      parseZip321Multi(`zcash:${A}?amount=1&address.1=${B}&amount.1=1&amount.1=2`),
    ).toThrow(/duplicate/);
  });

  it("still refuses an unrecognised req- parameter at any index", () => {
    expect(() => parseZip321Multi(`zcash:${A}?amount=1&req-shield=1`)).toThrow(/req-/);
    expect(() =>
      parseZip321Multi(`zcash:${A}?amount=1&address.1=${B}&amount.1=1&req-x.1=1`),
    ).toThrow(/req-/);
  });

  it("accepts the address-as-parameter form the ZIP says is equivalent", () => {
    const fromPath = parseZip321Multi(`zcash:${A}?amount=1`);
    const fromParam = parseZip321Multi(`zcash:?address=${A}&amount=1`);
    expect(fromParam).toEqual(fromPath);
  });

  it("returns payments in index order, however they were written", () => {
    const payments = parseZip321Multi(
      `zcash:?address.2=utest1c&amount.2=3&address=${A}&amount=1&address.1=${B}&amount.1=2`,
    );
    expect(payments.map((p) => p.address)).toEqual([A, B, "utest1c"]);
  });
});
