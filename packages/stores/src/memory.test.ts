import { beforeEach, describe, expect, it } from "vitest";
import { DuplicateInvoiceError, NETWORK_TESTNET, newInvoiceId } from "@byte-protocol/core";
import type { StoredInvoice } from "@byte-protocol/core";
import { MemoryInvoiceStore, MemoryReceiptStore } from "./memory.js";

function invoice(overrides: Partial<StoredInvoice> = {}): StoredInvoice {
  return {
    invoiceId: newInvoiceId(),
    network: NETWORK_TESTNET,
    amountZat: "100000",
    payTo: "utest1example",
    memo: "BYTE1|x|y",
    minConfirmations: 1,
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("MemoryInvoiceStore", () => {
  let store: MemoryInvoiceStore;
  beforeEach(() => {
    store = new MemoryInvoiceStore();
  });

  it("stores and retrieves an invoice", async () => {
    const i = invoice();
    await store.put(i);
    expect(await store.get(i.invoiceId)).toMatchObject({ invoiceId: i.invoiceId });
  });

  it("refuses to overwrite an existing invoice", async () => {
    const i = invoice();
    await store.put(i);
    await expect(store.put(i)).rejects.toThrow(DuplicateInvoiceError);
  });

  it("returns undefined for an unknown invoice", async () => {
    expect(await store.get("nope")).toBeUndefined();
  });

  it("copies on write so a caller cannot mutate the stored amount", async () => {
    // Holding the caller's object would let a later mutation change what the store
    // believes an invoice was issued for.
    const i = invoice({ amountZat: "100000" });
    await store.put(i);
    i.amountZat = "1";
    expect((await store.get(i.invoiceId))?.amountZat).toBe("100000");
  });

  it("copies on read so a caller cannot mutate the store", async () => {
    const i = invoice();
    await store.put(i);
    const read = await store.get(i.invoiceId);
    read!.amountZat = "999";
    expect((await store.get(i.invoiceId))?.amountZat).toBe("100000");
  });
});

describe("consume", () => {
  let store: MemoryInvoiceStore;
  beforeEach(() => {
    store = new MemoryInvoiceStore();
  });

  it("consumes once and refuses the second time", async () => {
    const i = invoice();
    await store.put(i);
    expect(await store.consume(i.invoiceId, "a".repeat(64))).toBe(true);
    expect(await store.consume(i.invoiceId, "a".repeat(64))).toBe(false);
  });

  it("records the settling transaction and the time", async () => {
    const i = invoice();
    await store.put(i);
    await store.consume(i.invoiceId, "b".repeat(64), 1234);
    const stored = await store.get(i.invoiceId);
    expect(stored?.txid).toBe("b".repeat(64));
    expect(stored?.consumedAt).toBe(1234);
  });

  it("refuses to consume an unknown invoice", async () => {
    expect(await store.consume("nope", "a".repeat(64))).toBe(false);
  });

  it("lets exactly one of many concurrent claims win", async () => {
    // This is the replay defence. If the test-and-set were not atomic, several of these
    // would observe an unconsumed invoice and all be served for one payment.
    const i = invoice();
    await store.put(i);

    const results = await Promise.all(
      Array.from({ length: 200 }, (_, n) =>
        store.consume(i.invoiceId, String(n).padStart(64, "0")),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("list", () => {
  let store: MemoryInvoiceStore;
  beforeEach(() => {
    store = new MemoryInvoiceStore();
  });

  it("returns newest first", async () => {
    const older = invoice({ createdAt: 1_000 });
    const newer = invoice({ createdAt: 2_000 });
    await store.put(older);
    await store.put(newer);
    const { invoices } = await store.list();
    expect(invoices[0]?.invoiceId).toBe(newer.invoiceId);
  });

  it("filters by status", async () => {
    const outstanding = invoice({ expiresAt: Date.now() + 60_000 });
    const expired = invoice({ expiresAt: Date.now() - 1 });
    const consumed = invoice();
    await store.put(outstanding);
    await store.put(expired);
    await store.put(consumed);
    await store.consume(consumed.invoiceId, "c".repeat(64));

    expect((await store.list({ status: "outstanding" })).invoices).toHaveLength(1);
    expect((await store.list({ status: "expired" })).invoices).toHaveLength(1);
    expect((await store.list({ status: "consumed" })).invoices).toHaveLength(1);
  });

  it("pages with a cursor and covers every invoice exactly once", async () => {
    for (let n = 0; n < 25; n++) await store.put(invoice({ createdAt: n }));

    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await store.list({ limit: 10, ...(cursor ? { cursor } : {}) });
      for (const i of result.invoices) seen.add(i.invoiceId);
      cursor = result.cursor;
      if (cursor === undefined) break;
    }
    expect(seen.size).toBe(25);
  });

  it("clamps an absurd or invalid limit", async () => {
    for (let n = 0; n < 60; n++) await store.put(invoice());
    expect((await store.list({ limit: 100_000 })).invoices.length).toBeLessThanOrEqual(500);
    expect((await store.list({ limit: -1 })).invoices).toHaveLength(50);
    expect((await store.list({ limit: 1.5 })).invoices).toHaveLength(50);
  });
});

describe("pruneExpired", () => {
  it("drops expired unconsumed invoices but never consumed ones", async () => {
    // A consumed invoice's record is what makes a replay detectable. Forgetting one
    // re-opens the window it was closing.
    const store = new MemoryInvoiceStore();
    const expired = invoice({ expiresAt: 1_000 });
    const consumedExpired = invoice({ expiresAt: 1_000 });
    const live = invoice({ expiresAt: Date.now() + 60_000 });

    await store.put(expired);
    await store.put(consumedExpired);
    await store.put(live);
    await store.consume(consumedExpired.invoiceId, "d".repeat(64));

    expect(await store.pruneExpired(2_000)).toBe(1);
    expect(await store.get(expired.invoiceId)).toBeUndefined();
    expect(await store.get(consumedExpired.invoiceId)).toBeDefined();
    expect(await store.get(live.invoiceId)).toBeDefined();
  });

  it("still refuses a replay of a consumed invoice after pruning", async () => {
    const store = new MemoryInvoiceStore();
    const i = invoice({ expiresAt: 1_000 });
    await store.put(i);
    await store.consume(i.invoiceId, "e".repeat(64));
    await store.pruneExpired(Date.now());
    expect(await store.consume(i.invoiceId, "e".repeat(64))).toBe(false);
  });
});

describe("MemoryReceiptStore", () => {
  it("stores, retrieves and lists receipts", async () => {
    const store = new MemoryReceiptStore();
    const receipt = {
      invoiceId: "0123456789abcdef0123456789abcdef",
      txid: "a".repeat(64),
      amount: "100000",
      payTo: "utest1example",
      network: NETWORK_TESTNET,
      timestamp: "2026-09-29T12:00:00Z",
      issuer: "b".repeat(64),
      signature: "c".repeat(128),
    };
    await store.put(receipt);
    expect(await store.get(receipt.invoiceId)).toMatchObject({ txid: receipt.txid });
    expect((await store.list()).receipts).toHaveLength(1);
    expect(await store.get("unknown")).toBeUndefined();
  });

  it("copies on read", async () => {
    const store = new MemoryReceiptStore();
    const receipt = {
      invoiceId: "0123456789abcdef0123456789abcdef",
      txid: "a".repeat(64),
      amount: "100000",
      payTo: "utest1example",
      network: NETWORK_TESTNET,
      timestamp: "2026-09-29T12:00:00Z",
      issuer: "b".repeat(64),
      signature: "c".repeat(128),
    };
    await store.put(receipt);
    const read = await store.get(receipt.invoiceId);
    read!.amount = "999";
    expect((await store.get(receipt.invoiceId))?.amount).toBe("100000");
  });
});
