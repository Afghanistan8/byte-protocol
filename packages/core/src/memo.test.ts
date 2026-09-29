import { describe, expect, it } from "vitest";
import {
  BINDING_BYTES,
  MEMO_SIZE,
  MEMO_VERSION,
  MIN_SECRET_BYTES,
  computeBinding,
  encodeMemo,
  fromMemoBytes,
  parseMemo,
  toMemoBytes,
  verifyMemo,
} from "./memo.js";
import { ByteMemoError } from "./errors.js";
import { utf8ToBytes } from "./bytes.js";

const secret = new Uint8Array(32).fill(7);
const otherSecret = new Uint8Array(32).fill(9);

const fields = {
  invoiceId: "0123456789abcdef0123456789abcdef",
  amountZat: "100000",
  payTo: "utest1exampleaddressexampleaddress",
};

describe("encodeMemo", () => {
  it("produces the documented shape", () => {
    const memo = encodeMemo(secret, fields);
    expect(memo.startsWith(`${MEMO_VERSION}|${fields.invoiceId}|`)).toBe(true);
    expect(memo.split("|")).toHaveLength(3);
  });

  it("fits well inside the 512-byte memo field", () => {
    const memo = encodeMemo(secret, fields);
    // 5 + 1 + 32 + 1 + 32
    expect(utf8ToBytes(memo)).toHaveLength(71);
    expect(utf8ToBytes(memo).length).toBeLessThan(MEMO_SIZE);
  });

  it("is deterministic for the same secret and fields", () => {
    expect(encodeMemo(secret, fields)).toBe(encodeMemo(secret, fields));
  });

  it("rejects an invoiceId that is not 32 lowercase hex characters", () => {
    for (const invoiceId of ["", "abc", fields.invoiceId.toUpperCase(), `${fields.invoiceId}00`]) {
      expect(() => encodeMemo(secret, { ...fields, invoiceId })).toThrow(ByteMemoError);
    }
  });

  it("refuses a secret shorter than the minimum", () => {
    const short = new Uint8Array(MIN_SECRET_BYTES - 1);
    expect(() => encodeMemo(short, fields)).toThrow(/at least 32 bytes/);
  });
});

describe("computeBinding", () => {
  it("is a 128-bit tag in lowercase hex", () => {
    const binding = computeBinding(secret, fields);
    expect(binding).toHaveLength(BINDING_BYTES * 2);
    expect(binding).toMatch(/^[0-9a-f]+$/);
  });

  it("changes when any bound field changes", () => {
    const base = computeBinding(secret, fields);
    expect(computeBinding(secret, { ...fields, amountZat: "100001" })).not.toBe(base);
    expect(computeBinding(secret, { ...fields, payTo: `${fields.payTo}x` })).not.toBe(base);
    expect(
      computeBinding(secret, { ...fields, invoiceId: "0123456789abcdef0123456789abcdee" }),
    ).not.toBe(base);
  });

  it("changes when the secret changes", () => {
    expect(computeBinding(otherSecret, fields)).not.toBe(computeBinding(secret, fields));
  });

  it("does not collide when field boundaries shift", () => {
    // Without a separator, ("ab","c") and ("a","bc") would hash identically. The null
    // separator is what stops a binding being replayable onto a different invoice.
    const a = computeBinding(secret, { ...fields, amountZat: "1", payTo: "23" });
    const b = computeBinding(secret, { ...fields, amountZat: "12", payTo: "3" });
    expect(a).not.toBe(b);
  });
});

describe("parseMemo", () => {
  it("round-trips an encoded memo", () => {
    const parsed = parseMemo(encodeMemo(secret, fields));
    expect(parsed.version).toBe(MEMO_VERSION);
    expect(parsed.invoiceId).toBe(fields.invoiceId);
    expect(parsed.binding).toBe(computeBinding(secret, fields));
  });

  it.each([
    ["not a string", 42],
    ["empty", ""],
    ["too few fields", "BYTE1|0123456789abcdef0123456789abcdef"],
    ["too many fields", "BYTE1|a|b|c"],
    ["unknown version", `BYTE0|${fields.invoiceId}|${"0".repeat(32)}`],
    ["uppercase invoiceId", `BYTE1|${fields.invoiceId.toUpperCase()}|${"0".repeat(32)}`],
    ["short invoiceId", `BYTE1|abc|${"0".repeat(32)}`],
    ["short binding", `BYTE1|${fields.invoiceId}|00`],
    ["non-hex binding", `BYTE1|${fields.invoiceId}|${"z".repeat(32)}`],
  ])("rejects %s", (_label, input) => {
    expect(() => parseMemo(input)).toThrow(ByteMemoError);
  });
});

describe("verifyMemo", () => {
  it("accepts a memo it issued", () => {
    expect(verifyMemo(secret, encodeMemo(secret, fields), fields)).toBe(true);
  });

  it("rejects a memo bound under a different secret", () => {
    expect(verifyMemo(secret, encodeMemo(otherSecret, fields), fields)).toBe(false);
  });

  it("rejects a memo replayed onto a different amount", () => {
    const memo = encodeMemo(secret, fields);
    expect(verifyMemo(secret, memo, { ...fields, amountZat: "999999" })).toBe(false);
  });

  it("rejects a memo replayed onto a different address", () => {
    const memo = encodeMemo(secret, fields);
    expect(verifyMemo(secret, memo, { ...fields, payTo: "utest1someotheraddress" })).toBe(false);
  });

  it("returns false rather than throwing on arbitrary input", () => {
    // A verifier scans notes carrying whatever bytes a stranger chose. It must not throw.
    for (const junk of [undefined, null, 0, {}, [], "", "\u0000", "BYTE1||", "a".repeat(5000)]) {
      expect(verifyMemo(secret, junk, fields)).toBe(false);
    }
  });

  it("returns false rather than throwing on an under-length secret", () => {
    expect(verifyMemo(new Uint8Array(4), encodeMemo(secret, fields), fields)).toBe(false);
  });
});

describe("memo bytes", () => {
  it("pads to exactly 512 bytes and round-trips", () => {
    const memo = encodeMemo(secret, fields);
    const bytes = toMemoBytes(memo);
    expect(bytes).toHaveLength(MEMO_SIZE);
    expect(bytes.slice(71).every((b) => b === 0)).toBe(true);
    expect(fromMemoBytes(bytes)).toBe(memo);
  });

  it("round-trips multi-byte UTF-8", () => {
    // Byte's own memos are ASCII, but the codec must not corrupt anything it is handed.
    const text = "BYTE1 ≈ ünïcodé ✓";
    expect(fromMemoBytes(toMemoBytes(text))).toBe(text);
  });

  it("rejects text over the limit", () => {
    expect(() => toMemoBytes("x".repeat(MEMO_SIZE + 1))).toThrow(ByteMemoError);
  });

  it("accepts text exactly at the limit", () => {
    expect(toMemoBytes("x".repeat(MEMO_SIZE))).toHaveLength(MEMO_SIZE);
  });

  it("rejects a field that is not 512 bytes", () => {
    expect(() => fromMemoBytes(new Uint8Array(100))).toThrow(ByteMemoError);
    expect(() => fromMemoBytes(new Uint8Array(513))).toThrow(ByteMemoError);
  });

  it("rejects invalid UTF-8 rather than substituting replacement characters", () => {
    const bytes = new Uint8Array(MEMO_SIZE);
    bytes.set([0xff, 0xfe, 0xfd]);
    expect(() => fromMemoBytes(bytes)).toThrow(/not valid UTF-8/);
  });

  it("decodes an all-zero field as empty", () => {
    expect(fromMemoBytes(new Uint8Array(MEMO_SIZE))).toBe("");
  });
});
