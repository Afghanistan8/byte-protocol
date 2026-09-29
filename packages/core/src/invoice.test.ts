import { describe, expect, it } from "vitest";
import {
  isConsumed,
  isExpired,
  parsePaymentPayload,
  parsePaymentRequirements,
} from "./invoice.js";
import type { StoredInvoice } from "./invoice.js";
import { BYTE_SCHEME, NETWORK_TESTNET } from "./network.js";
import { isInvoiceId, newInvoiceId, newMemoSecret } from "./ids.js";

const requirements = {
  scheme: BYTE_SCHEME,
  network: NETWORK_TESTNET,
  amount: "100000",
  asset: "ZEC",
  payTo: "utest1exampleaddressexampleaddress",
  invoiceId: "0123456789abcdef0123456789abcdef",
  expiresAt: "2026-09-29T12:05:00Z",
  minConfirmations: 1,
  memo: "BYTE1|0123456789abcdef0123456789abcdef|00112233445566778899aabbccddeeff",
  zip321: "zcash:utest1exampleaddressexampleaddress?amount=0.001",
};

describe("parsePaymentRequirements", () => {
  it("accepts a well-formed invoice", () => {
    expect(parsePaymentRequirements(requirements).invoiceId).toBe(requirements.invoiceId);
  });

  it("accepts an optional facilitator URL", () => {
    const parsed = parsePaymentRequirements({
      ...requirements,
      facilitator: "https://facilitator.example",
    });
    expect(parsed.facilitator).toBe("https://facilitator.example");
  });

  it.each([
    ["a foreign scheme", { scheme: "exact" }],
    ["an unknown network", { network: "zcash:deadbeef" }],
    ["a numeric amount", { amount: 100000 }],
    ["a non-integer amount", { amount: "1.5" }],
    ["a non-ZEC asset", { asset: "USDC" }],
    ["an empty payTo", { payTo: "" }],
    ["a malformed invoiceId", { invoiceId: "nope" }],
    ["a non-RFC-3339 expiry", { expiresAt: "tomorrow" }],
    ["negative confirmations", { minConfirmations: -1 }],
    ["fractional confirmations", { minConfirmations: 1.5 }],
    ["a zip321 that is not a zcash URI", { zip321: "https://example.com" }],
    ["a facilitator that is not a URL", { facilitator: "not a url" }],
  ])("rejects %s", (_label, patch) => {
    expect(() => parsePaymentRequirements({ ...requirements, ...patch })).toThrow();
  });

  it("rejects entirely unstructured input", () => {
    for (const junk of [null, undefined, 0, "", [], {}]) {
      expect(() => parsePaymentRequirements(junk)).toThrow();
    }
  });

  it("permits zero confirmations, which the spec allows only when configured", () => {
    expect(parsePaymentRequirements({ ...requirements, minConfirmations: 0 }).minConfirmations)
      .toBe(0);
  });
});

describe("parsePaymentPayload", () => {
  const payload = {
    scheme: BYTE_SCHEME,
    network: NETWORK_TESTNET,
    invoiceId: requirements.invoiceId,
    txid: "a".repeat(64),
  };

  it("accepts a well-formed payload", () => {
    expect(parsePaymentPayload(payload).txid).toBe(payload.txid);
  });

  it.each([
    ["a short txid", { txid: "abc" }],
    ["an uppercase txid", { txid: "A".repeat(64) }],
    ["a mismatched scheme", { scheme: "exact" }],
    ["an unknown network", { network: "zcash:00000000000000000000000000000000" }],
  ])("rejects %s", (_label, patch) => {
    expect(() => parsePaymentPayload({ ...payload, ...patch })).toThrow();
  });
});

describe("invoice state", () => {
  const invoice: StoredInvoice = {
    invoiceId: requirements.invoiceId,
    network: NETWORK_TESTNET,
    amountZat: "100000",
    payTo: requirements.payTo,
    memo: requirements.memo,
    minConfirmations: 1,
    expiresAt: 1_000,
    createdAt: 0,
  };

  it("is expired only once expiresAt has passed", () => {
    expect(isExpired(invoice, 999)).toBe(false);
    expect(isExpired(invoice, 1_000)).toBe(true);
    expect(isExpired(invoice, 1_001)).toBe(true);
  });

  it("is unconsumed until consumedAt is set", () => {
    expect(isConsumed(invoice)).toBe(false);
    expect(isConsumed({ ...invoice, consumedAt: 500 })).toBe(true);
  });
});

describe("identifiers", () => {
  it("mints 32 lowercase hex characters", () => {
    const id = newInvoiceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(isInvoiceId(id)).toBe(true);
  });

  it("does not repeat across a large sample", () => {
    const ids = new Set(Array.from({ length: 5_000 }, newInvoiceId));
    expect(ids.size).toBe(5_000);
  });

  it("rejects malformed identifiers", () => {
    for (const v of ["", "abc", "A".repeat(32), "g".repeat(32), null, 5]) {
      expect(isInvoiceId(v)).toBe(false);
    }
  });

  it("mints memo secrets at the minimum length", () => {
    expect(newMemoSecret()).toHaveLength(32);
    expect(newMemoSecret()).not.toEqual(newMemoSecret());
  });
});
