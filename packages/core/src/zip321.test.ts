import { describe, expect, it } from "vitest";
import { buildZip321, parseZip321 } from "./zip321.js";
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
    ).toThrow(/multi-payment/);
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
