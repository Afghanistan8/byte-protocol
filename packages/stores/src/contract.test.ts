/**
 * One contract, run against every store.
 *
 * `InvoiceStore` and `ReceiptStore` are interfaces other packages code against, so "the
 * memory one behaves like this and the SQLite one behaves like that" is a bug waiting for
 * whoever switches. Every implementation runs the same suite.
 *
 * The `consume` cases are the important ones. It is the replay defence: two concurrent
 * claims on one invoice must produce exactly one `true`, or two callers get served for one
 * payment.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DuplicateInvoiceError,
  NETWORK_TESTNET,
  newSigningKey,
  signReceipt,
  type ByteReceipt,
  type InvoiceStore,
  type ReceiptStore,
  type StoredInvoice,
} from "@byte-protocol/core";
import { MemoryInvoiceStore, MemoryReceiptStore } from "./memory.js";
import { SqliteInvoiceStore, SqliteReceiptStore, createSqliteStores } from "./sqlite.js";

interface Implementation {
  name: string;
  /** A fresh, empty pair of stores. */
  create: () => { invoices: InvoiceStore; receipts: ReceiptStore; close: () => void };
  /**
   * Reopen the same storage, if this implementation survives a restart.
   *
   * `undefined` for the memory store, which does not, and the durability test skips it
   * rather than asserting something false about it.
   */
  reopen?: (handle: unknown) => { invoices: InvoiceStore; receipts: ReceiptStore; close: () => void };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "byte-stores-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const implementations: Implementation[] = [
  {
    name: "memory",
    create: () => ({
      invoices: new MemoryInvoiceStore(),
      receipts: new MemoryReceiptStore(),
      close: () => {},
    }),
  },
  {
    name: "sqlite",
    create: () => {
      const stores = createSqliteStores(join(tmp, "byte.db"));
      return { invoices: stores.invoices, receipts: stores.receipts, close: stores.close };
    },
    reopen: () => {
      const stores = createSqliteStores(join(tmp, "byte.db"));
      return { invoices: stores.invoices, receipts: stores.receipts, close: stores.close };
    },
  },
];

function invoice(overrides: Partial<StoredInvoice> = {}): StoredInvoice {
  return {
    invoiceId: "a".repeat(32),
    network: NETWORK_TESTNET,
    amountZat: "100000",
    payTo: "utest1payee",
    memo: "BYTE1|abc|def",
    minConfirmations: 1,
    expiresAt: Date.now() + 300_000,
    createdAt: Date.now(),
    ...overrides,
  };
}

function receiptFor(invoiceId: string): ByteReceipt {
  const { secretKey } = newSigningKey();
  return signReceipt(secretKey, {
    invoiceId,
    txid: "b".repeat(64),
    amount: "100000",
    payTo: "utest1payee",
    network: NETWORK_TESTNET,
    timestamp: "2026-09-30T00:00:00.000Z",
  });
}

describe.each(implementations)("$name invoice store", (impl) => {
  let store: ReturnType<Implementation["create"]>;

  beforeEach(() => {
    store = impl.create();
  });
  afterEach(() => store.close());

  it("round-trips an invoice", async () => {
    const one = invoice();
    await store.invoices.put(one);
    expect(await store.invoices.get(one.invoiceId)).toEqual(one);
  });

  it("round-trips the optional fields", async () => {
    // price, fee and metadata all travel as JSON in SQLite; a store that dropped one would
    // lose the rate an invoice was charged at, or the fee a facilitator is owed.
    const one = invoice({
      metadata: { orderId: "42", nested: { deep: true } },
      price: { priceUsd: "2.00", zecUsd: 200, priceSource: "test", quotedAt: "2026-09-30T00:00:00Z" },
      fee: { amount: "1000", payTo: "utest1facil", bps: 100 },
    });
    await store.invoices.put(one);
    expect(await store.invoices.get(one.invoiceId)).toEqual(one);
  });

  it("returns undefined for an unknown invoice", async () => {
    expect(await store.invoices.get("f".repeat(32))).toBeUndefined();
  });

  it("refuses a duplicate id", async () => {
    await store.invoices.put(invoice());
    await expect(store.invoices.put(invoice())).rejects.toThrow(DuplicateInvoiceError);
  });

  it("consumes exactly once", async () => {
    const one = invoice();
    await store.invoices.put(one);

    expect(await store.invoices.consume(one.invoiceId, "c".repeat(64))).toBe(true);
    expect(await store.invoices.consume(one.invoiceId, "d".repeat(64))).toBe(false);
  });

  it("records the txid and time it was consumed", async () => {
    const one = invoice();
    await store.invoices.put(one);
    await store.invoices.consume(one.invoiceId, "c".repeat(64), 1_700_000_000_000);

    const settled = await store.invoices.get(one.invoiceId);
    expect(settled?.consumedAt).toBe(1_700_000_000_000);
    expect(settled?.txid).toBe("c".repeat(64));
  });

  it("does not consume an invoice it has never seen", async () => {
    expect(await store.invoices.consume("f".repeat(32), "c".repeat(64))).toBe(false);
  });

  it("gives exactly one winner under concurrent consume", async () => {
    // The replay defence. If two of these returned true, two callers would be served for
    // one payment.
    const one = invoice();
    await store.invoices.put(one);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.invoices.consume(one.invoiceId, String(i).padStart(64, "0")),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("lists newest first", async () => {
    for (let i = 0; i < 5; i++) {
      await store.invoices.put(
        invoice({ invoiceId: String(i).repeat(32), createdAt: 1000 + i * 10 }),
      );
    }
    const { invoices } = await store.invoices.list();
    expect(invoices.map((i) => i.createdAt)).toEqual([1040, 1030, 1020, 1010, 1000]);
  });

  it("filters by status", async () => {
    const now = Date.now();
    await store.invoices.put(invoice({ invoiceId: "1".repeat(32), expiresAt: now + 300_000 }));
    await store.invoices.put(invoice({ invoiceId: "2".repeat(32), expiresAt: now - 1 }));
    await store.invoices.put(invoice({ invoiceId: "3".repeat(32), expiresAt: now + 300_000 }));
    await store.invoices.consume("3".repeat(32), "c".repeat(64));

    const outstanding = await store.invoices.list({ status: "outstanding" });
    const expired = await store.invoices.list({ status: "expired" });
    const consumed = await store.invoices.list({ status: "consumed" });

    expect(outstanding.invoices.map((i) => i.invoiceId)).toEqual(["1".repeat(32)]);
    expect(expired.invoices.map((i) => i.invoiceId)).toEqual(["2".repeat(32)]);
    expect(consumed.invoices.map((i) => i.invoiceId)).toEqual(["3".repeat(32)]);
  });

  it("does not report a consumed invoice as expired", async () => {
    // A consumed invoice past its expiry is settled, not expired. Reporting it as expired
    // would make a paid invoice look unpaid in the owner console.
    const one = invoice({ expiresAt: Date.now() - 1 });
    await store.invoices.put(one);
    await store.invoices.consume(one.invoiceId, "c".repeat(64));

    const expired = await store.invoices.list({ status: "expired" });
    expect(expired.invoices).toHaveLength(0);
  });

  it("pages without repeating or skipping", async () => {
    for (let i = 0; i < 25; i++) {
      await store.invoices.put(
        invoice({ invoiceId: String(i).padStart(32, "0"), createdAt: 1000 + i }),
      );
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.invoices.list({
        limit: 10,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      seen.push(...page.invoices.map((i) => i.invoiceId));
      cursor = page.cursor;
    } while (cursor !== undefined);

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it("prunes expired invoices but never consumed ones", async () => {
    // A consumed record is what makes a replay detectable. Deleting one re-opens the window
    // it was closing, so pruning must never touch it however old it is.
    const now = Date.now();
    await store.invoices.put(invoice({ invoiceId: "1".repeat(32), expiresAt: now - 10_000 }));
    await store.invoices.put(invoice({ invoiceId: "2".repeat(32), expiresAt: now - 10_000 }));
    await store.invoices.consume("2".repeat(32), "c".repeat(64));

    const removed = await store.invoices.pruneExpired(now);

    expect(removed).toBe(1);
    expect(await store.invoices.get("1".repeat(32))).toBeUndefined();
    expect(await store.invoices.get("2".repeat(32))).toBeDefined();
  });
});

describe.each(implementations)("$name receipt store", (impl) => {
  let store: ReturnType<Implementation["create"]>;

  beforeEach(() => {
    store = impl.create();
  });
  afterEach(() => store.close());

  it("round-trips a receipt", async () => {
    const receipt = receiptFor("a".repeat(32));
    await store.receipts.put(receipt);
    expect(await store.receipts.get(receipt.invoiceId)).toEqual(receipt);
  });

  it("returns undefined for an unknown invoice", async () => {
    expect(await store.receipts.get("f".repeat(32))).toBeUndefined();
  });

  it("lists what it holds", async () => {
    for (let i = 0; i < 3; i++) await store.receipts.put(receiptFor(String(i).repeat(32)));
    const { receipts } = await store.receipts.list();
    expect(receipts).toHaveLength(3);
  });

  it("pages without repeating", async () => {
    for (let i = 0; i < 12; i++) {
      await store.receipts.put(receiptFor(String(i).padStart(32, "0")));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.receipts.list({
        limit: 5,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      seen.push(...page.receipts.map((r) => r.invoiceId));
      cursor = page.cursor;
    } while (cursor !== undefined);

    expect(new Set(seen).size).toBe(12);
  });
});

describe("durability", () => {
  const durable = implementations.filter((i) => i.reopen !== undefined);

  it("the memory store is honest about not being durable", () => {
    // Stated as a test rather than only in a comment: the memory store is listed in the
    // README as not durable, and this is the line that keeps that claim true.
    expect(implementations.find((i) => i.name === "memory")?.reopen).toBeUndefined();
  });

  it.each(durable)("$name survives a restart", async (impl) => {
    const first = impl.create();
    const one = invoice();
    await first.invoices.put(one);
    await first.invoices.consume(one.invoiceId, "c".repeat(64));
    await first.receipts.put(receiptFor(one.invoiceId));
    first.close();

    // A new process, the same file.
    const second = (impl.reopen as NonNullable<Implementation["reopen"]>)(undefined);
    try {
      // The point of the whole exercise: a restart must not re-open the replay window.
      expect(await second.invoices.consume(one.invoiceId, "d".repeat(64))).toBe(false);

      const settled = await second.invoices.get(one.invoiceId);
      expect(settled?.consumedAt).toBeDefined();
      expect(await second.receipts.get(one.invoiceId)).toBeDefined();
    } finally {
      second.close();
    }
  });
});

describe("SqliteInvoiceStore specifics", () => {
  it("can share one database with the receipt store", () => {
    const stores = createSqliteStores(join(tmp, "shared.db"));
    try {
      expect(stores.invoices.database).toBe(stores.receipts.database);
    } finally {
      stores.close();
    }
  });

  it("does not close a database it was handed", async () => {
    // Closing a shared connection out from under the other store would turn one store's
    // cleanup into the other store's outage.
    const stores = createSqliteStores(join(tmp, "shared.db"));
    try {
      const borrower = new SqliteInvoiceStore({
        path: join(tmp, "shared.db"),
        database: stores.database,
      });
      borrower.close();

      await stores.invoices.put(invoice());
      expect(await stores.invoices.get("a".repeat(32))).toBeDefined();
    } finally {
      stores.close();
    }
  });

  it("creates its schema on an empty file", async () => {
    const store = new SqliteInvoiceStore({ path: join(tmp, "fresh.db") });
    try {
      await store.put(invoice());
      expect(await store.get("a".repeat(32))).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("keeps receipts through a reopen of a shared database", async () => {
    const path = join(tmp, "shared2.db");
    const first = createSqliteStores(path);
    await first.receipts.put(receiptFor("e".repeat(32)));
    first.close();

    const second = new SqliteReceiptStore({ path });
    try {
      expect(await second.get("e".repeat(32))).toBeDefined();
    } finally {
      second.close();
    }
  });
});
