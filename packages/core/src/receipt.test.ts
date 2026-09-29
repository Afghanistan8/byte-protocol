import { describe, expect, it } from "vitest";
import {
  canonicalReceiptBytes,
  newSigningKey,
  publicKeyOf,
  signReceipt,
  verifyReceipt,
} from "./receipt.js";
import { NETWORK_TESTNET } from "./network.js";
import type { ReceiptBody } from "./receipt.js";
import { ByteProtocolError } from "./errors.js";

const body: ReceiptBody = {
  invoiceId: "0123456789abcdef0123456789abcdef",
  txid: "a".repeat(64),
  amount: "100000",
  payTo: "utest1exampleaddressexampleaddress",
  network: NETWORK_TESTNET,
  timestamp: "2026-09-29T12:00:00Z",
};

describe("signReceipt / verifyReceipt", () => {
  it("verifies a receipt it signed", () => {
    const { secretKey } = newSigningKey();
    expect(verifyReceipt(signReceipt(secretKey, body))).toBe(true);
  });

  it("reports the signing key as issuer", () => {
    const { secretKey, publicKey } = newSigningKey();
    expect(signReceipt(secretKey, body).issuer).toBe(publicKey);
    expect(publicKeyOf(secretKey)).toBe(publicKey);
  });

  it("accepts a matching expected issuer and rejects a mismatched one", () => {
    const { secretKey, publicKey } = newSigningKey();
    const other = newSigningKey();
    const receipt = signReceipt(secretKey, body);
    expect(verifyReceipt(receipt, publicKey)).toBe(true);
    expect(verifyReceipt(receipt, other.publicKey)).toBe(false);
  });

  it.each([
    ["invoiceId", "ffffffffffffffffffffffffffffffff"],
    ["txid", "b".repeat(64)],
    ["amount", "999999"],
    ["payTo", "utest1different"],
    ["timestamp", "2026-09-29T12:00:01Z"],
  ])("rejects a receipt whose %s was altered after signing", (field, value) => {
    const { secretKey } = newSigningKey();
    const receipt = { ...signReceipt(secretKey, body), [field]: value };
    expect(verifyReceipt(receipt)).toBe(false);
  });

  it("rejects a receipt re-signed by a different key but claiming the original issuer", () => {
    const a = newSigningKey();
    const b = newSigningKey();
    const forged = { ...signReceipt(b.secretKey, body), issuer: a.publicKey };
    expect(verifyReceipt(forged)).toBe(false);
  });

  it("returns false rather than throwing on arbitrary input", () => {
    for (const junk of [undefined, null, 0, "", [], {}, { issuer: "x", signature: "y" }]) {
      expect(verifyReceipt(junk)).toBe(false);
    }
  });

  it("rejects a receipt missing a required field", () => {
    const { secretKey } = newSigningKey();
    const receipt = signReceipt(secretKey, body) as Record<string, unknown>;
    delete receipt["amount"];
    expect(verifyReceipt(receipt)).toBe(false);
  });
});

describe("canonicalReceiptBytes", () => {
  it("is stable regardless of key insertion order", () => {
    // JSON.stringify would not be: key order is an implementation detail, and a verifier
    // cannot rely on reproducing another engine's output byte for byte.
    const reordered: ReceiptBody = {
      timestamp: body.timestamp,
      network: body.network,
      payTo: body.payTo,
      amount: body.amount,
      txid: body.txid,
      invoiceId: body.invoiceId,
    };
    expect(canonicalReceiptBytes(reordered)).toEqual(canonicalReceiptBytes(body));
  });

  it("is domain-separated", () => {
    expect(new TextDecoder().decode(canonicalReceiptBytes(body))).toMatch(/^byte-receipt-v1\u0000/);
  });

  it("refuses fields containing the separator", () => {
    expect(() => canonicalReceiptBytes({ ...body, payTo: "a\u0000b" })).toThrow(
      ByteProtocolError,
    );
  });

  it("does not collide when field boundaries shift", () => {
    const a = canonicalReceiptBytes({ ...body, amount: "1", payTo: "23" });
    const b = canonicalReceiptBytes({ ...body, amount: "12", payTo: "3" });
    expect(a).not.toEqual(b);
  });
});
