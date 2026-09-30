import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hexToBytes, newSigningKey, signEd25519, utf8ToBytes } from "@byte-protocol/core";
import {
  ONE_CLICK_MANAGER_PUB_KEY,
  base58Decode,
  base58Encode,
  quoteHash,
  stableStringify,
  verifyQuoteSignature,
} from "./quote-signature.js";

/**
 * A REAL signed response from the live 1Click API, captured 2026-09-29 with a dry request
 * carrying only public example values (a documentation address, a throwaway refund address).
 *
 * This is the test that matters. Every other test here signs with a key I generated, which
 * proves my code agrees with my code. This one proves it agrees with 1Click: the key, the
 * field selection, the sorted-key serialization and the "sign the Base58 string, not the
 * digest" detail are all pinned by a signature I did not produce.
 */
const REAL = JSON.parse(
  readFileSync(new URL("./fixtures/live-dry-quote-2026-09-29.json", import.meta.url), "utf8"),
) as Record<string, any>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("a real signed quote from 1Click", () => {
  it("verifies against the published manager key", () => {
    expect(verifyQuoteSignature(REAL)).toBe(true);
  });

  it("reproduces the exact hash 1Click signed", () => {
    expect(quoteHash(REAL)).toBe("B8KyfmgqXaDkN7bPez31sTtM5e6vn6xYNnpFGjCAgeKc");
  });

  it("is a dry quote: no deposit address, which is the shape the rail must survive", () => {
    expect(REAL.quoteRequest.dry).toBe(true);
    expect(REAL.quote.depositAddress).toBeUndefined();
  });

  it("carries an appFees entry Byte never asked for, and it is not signed", () => {
    // 1Click added a 20 bps fee to the echoed request. The SDK leaves appFees out of the
    // signed set, so it does not affect verification; Byte surfaces it in the fee breakdown
    // instead, because a fee nobody mentioned is precisely what a caller should be shown.
    expect(REAL.quoteRequest.appFees).toEqual([expect.objectContaining({ fee: 20 })]);
    const withoutIt = clone(REAL);
    delete withoutIt.quoteRequest.appFees;
    expect(verifyQuoteSignature(withoutIt)).toBe(true);
  });

  it.each([
    ["the amount Byte would receive", (r: any) => (r.quote.amountOut = "20000000")],
    ["the amount Byte would pay", (r: any) => (r.quote.amountIn = "1")],
    ["the minimum out", (r: any) => (r.quote.minAmountOut = "1")],
    ["the recipient", (r: any) => (r.quoteRequest.recipient = "t1attackerattackerattackerattack")],
    ["the refund address", (r: any) => (r.quoteRequest.refundTo = "0xattacker")],
    ["the origin asset", (r: any) => (r.quoteRequest.originAsset = "nep141:other")],
    ["the destination asset", (r: any) => (r.quoteRequest.destinationAsset = "nep141:other")],
    ["the deadline", (r: any) => (r.quoteRequest.deadline = "2099-01-01T00:00:00.000Z")],
    ["the timestamp", (r: any) => (r.timestamp = "2026-09-29T21:48:39.244Z")],
    ["the dry flag", (r: any) => (r.quoteRequest.dry = false)],
  ])("refuses a response where %s was altered", (_name, mutate) => {
    const tampered = clone(REAL);
    mutate(tampered);
    expect(verifyQuoteSignature(tampered)).toBe(false);
  });

  it("refuses a signature from a different key", () => {
    const other = newSigningKey();
    expect(
      verifyQuoteSignature(REAL, {
        publicKey: `ed25519:${base58Encode(hexToBytes(other.publicKey))}`,
      }),
    ).toBe(false);
  });
});

describe("malformed input reads as not verified, never as an exception", () => {
  it.each([
    ["null", null],
    ["a string", "signed"],
    ["an empty object", {}],
    ["no signature", (() => { const r = clone(REAL); delete r.signature; return r; })()],
    ["a non-string signature", { ...clone(REAL), signature: 42 }],
    ["a signature that is not base58", { ...clone(REAL), signature: "ed25519:not*base58!" }],
    ["a signature of the wrong length", { ...clone(REAL), signature: "ed25519:2NEpo7TZRRrLZSi2U" }],
    ["no timestamp", (() => { const r = clone(REAL); delete r.timestamp; return r; })()],
    ["no quote", (() => { const r = clone(REAL); delete r.quote; return r; })()],
  ])("%s", (_name, input) => {
    expect(() => verifyQuoteSignature(input)).not.toThrow();
    expect(verifyQuoteSignature(input)).toBe(false);
  });

  it("refuses a malformed manager key rather than throwing", () => {
    expect(verifyQuoteSignature(REAL, { publicKey: "ed25519:0OIl" })).toBe(false);
  });
});

describe("a live quote, signed by a stand-in for 1Click", () => {
  /**
   * The real fixture is dry. A live quote has a `depositAddress`, and that address is the
   * thing an attacker would swap, so the live field selection needs coverage. A real one
   * cannot be captured without reserving a deposit address, which is the "live" step Byte
   * does not take without a JWT and Asuzu's say-so. The stand-in follows the SDK's
   * `buildSignedQuote` exactly, so this pins Byte's reading of that code.
   */
  const key = newSigningKey();
  const publicKey = `ed25519:${base58Encode(hexToBytes(key.publicKey))}`;

  function signedLive(overrides: Record<string, unknown> = {}) {
    const response: Record<string, any> = {
      quote: {
        amountIn: "143553700",
        amountInFormatted: "143.5537",
        amountInUsd: "143.5",
        minAmountIn: "142118163",
        amountOut: "10000000",
        amountOutFormatted: "0.1",
        amountOutUsd: "139.9",
        minAmountOut: "10000000",
        depositAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        deadline: "2026-09-29T22:48:22.000Z",
        timeEstimate: 150,
        refundFee: "2400",
        withdrawFee: "32000",
        ...overrides,
      },
      quoteRequest: { ...clone(REAL.quoteRequest), dry: false },
      timestamp: "2026-09-29T21:48:38.244Z",
    };
    const message = utf8ToBytes(quoteHash(response));
    response.signature = `ed25519:${base58Encode(signEd25519(message, key.secretKey))}`;
    return response;
  }

  it("verifies", () => {
    expect(verifyQuoteSignature(signedLive(), { publicKey })).toBe(true);
  });

  it("refuses a swapped deposit address, which is the attack that matters", () => {
    const response = signedLive();
    response.quote.depositAddress = "0xattackerattackerattackerattackerattacker00";
    expect(verifyQuoteSignature(response, { publicKey })).toBe(false);
  });

  it("refuses an added or altered memo", () => {
    const response = signedLive({ depositMemo: "12345" });
    response.quote.depositMemo = "99999";
    expect(verifyQuoteSignature(response, { publicKey })).toBe(false);
  });

  it("refuses an altered fee", () => {
    const response = signedLive();
    response.quote.withdrawFee = "1";
    expect(verifyQuoteSignature(response, { publicKey })).toBe(false);
  });
});

describe("stableStringify", () => {
  it("sorts keys and writes no whitespace", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("omits undefined object values entirely, which is what drops unsigned fields", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("keeps array order and writes an undefined element as null", () => {
    expect(stableStringify([3, undefined, 1])).toBe("[3,null,1]");
  });

  it("escapes strings as JSON does", () => {
    expect(stableStringify({ k: 'a"b\\c\n' })).toBe('{"k":"a\\"b\\\\c\\n"}');
  });

  it("writes null, booleans and numbers", () => {
    expect(stableStringify({ n: null, t: true, f: false, x: 1.5 })).toBe(
      '{"f":false,"n":null,"t":true,"x":1.5}',
    );
  });
});

describe("base58", () => {
  it("round-trips", () => {
    for (const bytes of [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([0, 0, 1]),
      new Uint8Array(32).fill(255),
    ]) {
      expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    }
  });

  it("preserves leading zero bytes as leading 1s", () => {
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe("112");
  });

  it("matches the alphabet Bitcoin uses", () => {
    expect(base58Encode(utf8ToBytes("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
  });

  it("decodes the published manager key to a 32-byte Ed25519 key", () => {
    expect(base58Decode(ONE_CLICK_MANAGER_PUB_KEY.slice("ed25519:".length))).toHaveLength(32);
  });

  it("refuses characters outside the alphabet", () => {
    expect(() => base58Decode("0OIl")).toThrow();
  });
});
