import { describe, expect, it } from "vitest";
import {
  canonicalReceiptBytes,
  newSigningKey,
  publicKeyOf,
  receiptBodyFor,
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
    expect(new TextDecoder().decode(canonicalReceiptBytes(body))).toMatch(/^byte-receipt-v2\u0000/);
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

describe("priced receipts", () => {
  const priced: ReceiptBody = {
    invoiceId: "a".repeat(32),
    txid: "b".repeat(64),
    amount: "1000000",
    payTo: "utest1payee",
    network: NETWORK_TESTNET,
    timestamp: "2026-09-29T12:00:00.000Z",
    priceUsd: "2.00",
    zecUsd: 200,
  };

  it("signs and verifies the USD side along with the ZEC side", () => {
    const { secretKey } = newSigningKey();
    const receipt = signReceipt(secretKey, priced);

    expect(verifyReceipt(receipt)).toBe(true);
    expect(receipt.priceUsd).toBe("2.00");
    expect(receipt.zecUsd).toBe(200);
  });

  it("refuses a receipt whose price was altered after signing", () => {
    // The denomination is as much a claim as the amount. A receipt that could be
    // re-denominated after the fact proves nothing about what was charged.
    const { secretKey } = newSigningKey();
    const receipt = signReceipt(secretKey, priced);

    expect(verifyReceipt({ ...receipt, priceUsd: "200.00" })).toBe(false);
    expect(verifyReceipt({ ...receipt, zecUsd: 2 })).toBe(false);
  });

  it("refuses a priced receipt with the price fields stripped", () => {
    // Stripping must not silently downgrade it to a valid unpriced receipt.
    const { secretKey } = newSigningKey();
    const { priceUsd: _u, zecUsd: _z, ...stripped } = signReceipt(secretKey, priced);
    void _u;
    void _z;

    expect(verifyReceipt(stripped)).toBe(false);
  });

  it("does not let an unpriced receipt pass as a priced one", () => {
    const { secretKey } = newSigningKey();
    const { priceUsd: _u, zecUsd: _z, ...unpricedBody } = priced;
    void _u;
    void _z;
    const receipt = signReceipt(secretKey, unpricedBody);

    expect(verifyReceipt(receipt)).toBe(true);
    expect(verifyReceipt({ ...receipt, priceUsd: "2.00", zecUsd: 200 })).toBe(false);
  });
});

describe("receiptBodyFor", () => {
  it("carries the USD denomination across from a priced invoice", () => {
    const body = receiptBodyFor(
      {
        invoiceId: "c".repeat(32),
        amountZat: "1000000",
        payTo: "utest1payee",
        network: NETWORK_TESTNET,
        price: { priceUsd: "2.00", zecUsd: 200 },
      },
      "d".repeat(64),
      Date.parse("2026-09-29T12:00:00Z"),
    );

    expect(body).toMatchObject({ amount: "1000000", priceUsd: "2.00", zecUsd: 200 });
    expect(body.timestamp).toBe("2026-09-29T12:00:00.000Z");
  });

  it("leaves the price fields absent on an unpriced invoice", () => {
    const body = receiptBodyFor(
      {
        invoiceId: "c".repeat(32),
        amountZat: "1000000",
        payTo: "utest1payee",
        network: NETWORK_TESTNET,
      },
      "d".repeat(64),
    );

    expect(body.priceUsd).toBeUndefined();
    expect(body.zecUsd).toBeUndefined();
  });
});
