/**
 * Durable invoice and receipt stores, on SQLite.
 *
 * ## Why this exists
 *
 * The memory store loses consumed-invoice records on restart, and a forgotten consumed
 * invoice is a **replay window**: a payer can present the same payment again and be served
 * twice. Until now that was the honest state of the project and SECURITY.md said so. It is
 * not a limitation worth keeping.
 *
 * ## Why SQLite, and why `node:sqlite`
 *
 * No dependency and no infrastructure: Node ships `node:sqlite` from 22.5. A payment
 * library that needs a server running before it can refuse a replay will be deployed
 * without one.
 *
 * It suits what Byte is: a single payee process with one durable file. It does not suit
 * several processes sharing one payee, and this file says so rather than letting someone
 * find out. Redis would be the answer there, behind the same interface and the same
 * contract tests.
 *
 * ## The one thing that must not be got wrong
 *
 * `consume` is the replay defence. A read-then-write, however tight, has a window in which
 * two concurrent claims both see an unconsumed invoice and both get served for one payment.
 * Here it is a **single conditional UPDATE**, and the row count decides the answer. SQLite
 * serializes writers, so the condition and the write cannot be separated by anything.
 */

import { DatabaseSync } from "node:sqlite";
import {
  DuplicateInvoiceError,
  type ByteReceipt,
  type InvoiceStore,
  type ReceiptStore,
  type StoredInvoice,
} from "@byte-protocol/core";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/**
 * Open a database and apply the schema.
 *
 * `WAL` so a reader never blocks the writer, and `synchronous = FULL` because the whole
 * point of this store is surviving a crash: `NORMAL` can lose the most recent commits on
 * power loss, and the most recent commit is exactly the consumed-invoice record that stops
 * a replay.
 */
export function openByteDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      invoice_id        TEXT PRIMARY KEY,
      network           TEXT NOT NULL,
      amount_zat        TEXT NOT NULL,
      pay_to            TEXT NOT NULL,
      memo              TEXT NOT NULL,
      min_confirmations INTEGER NOT NULL,
      expires_at        INTEGER NOT NULL,
      created_at        INTEGER NOT NULL,
      consumed_at       INTEGER,
      txid              TEXT,
      metadata          TEXT,
      price             TEXT,
      fee               TEXT
    );
    CREATE INDEX IF NOT EXISTS invoices_created_at ON invoices (created_at DESC);
    CREATE INDEX IF NOT EXISTS invoices_expiry ON invoices (consumed_at, expires_at);

    CREATE TABLE IF NOT EXISTS receipts (
      invoice_id TEXT PRIMARY KEY,
      body       TEXT NOT NULL,
      stored_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS receipts_stored_at ON receipts (stored_at DESC);
  `);

  return db;
}

interface InvoiceRow {
  invoice_id: string;
  network: string;
  amount_zat: string;
  pay_to: string;
  memo: string;
  min_confirmations: number;
  expires_at: number;
  created_at: number;
  consumed_at: number | null;
  txid: string | null;
  metadata: string | null;
  price: string | null;
  fee: string | null;
}

function toInvoice(row: InvoiceRow): StoredInvoice {
  return {
    invoiceId: row.invoice_id,
    network: row.network as StoredInvoice["network"],
    amountZat: row.amount_zat,
    payTo: row.pay_to,
    memo: row.memo,
    minConfirmations: row.min_confirmations,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    ...(row.consumed_at !== null ? { consumedAt: row.consumed_at } : {}),
    ...(row.txid !== null ? { txid: row.txid } : {}),
    ...(row.metadata !== null
      ? { metadata: JSON.parse(row.metadata) as Record<string, unknown> }
      : {}),
    // `NonNullable` because `exactOptionalPropertyTypes` distinguishes "absent" from
    // "present and undefined", and the conditional spread already guarantees the former.
    ...(row.price !== null
      ? { price: JSON.parse(row.price) as NonNullable<StoredInvoice["price"]> }
      : {}),
    ...(row.fee !== null ? { fee: JSON.parse(row.fee) as NonNullable<StoredInvoice["fee"]> } : {}),
  };
}

export interface SqliteStoreOptions {
  /**
   * Where the database lives. `:memory:` is accepted, and is a **test-only** setting: an
   * in-memory SQLite database is exactly as durable as the memory store, which is to say
   * not at all.
   */
  path: string;
  /** Share one open database between the invoice and receipt stores. */
  database?: DatabaseSync;
}

export class SqliteInvoiceStore implements InvoiceStore {
  readonly #db: DatabaseSync;
  readonly #owned: boolean;

  constructor(options: SqliteStoreOptions) {
    this.#owned = options.database === undefined;
    this.#db = options.database ?? openByteDatabase(options.path);
  }

  /** The open database, so a receipt store can share it. */
  get database(): DatabaseSync {
    return this.#db;
  }

  async put(invoice: StoredInvoice): Promise<void> {
    try {
      this.#db
        .prepare(
          `INSERT INTO invoices (
             invoice_id, network, amount_zat, pay_to, memo, min_confirmations,
             expires_at, created_at, consumed_at, txid, metadata, price, fee
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          invoice.invoiceId,
          invoice.network,
          invoice.amountZat,
          invoice.payTo,
          invoice.memo,
          invoice.minConfirmations,
          invoice.expiresAt,
          invoice.createdAt,
          invoice.consumedAt ?? null,
          invoice.txid ?? null,
          invoice.metadata !== undefined ? JSON.stringify(invoice.metadata) : null,
          invoice.price !== undefined ? JSON.stringify(invoice.price) : null,
          invoice.fee !== undefined ? JSON.stringify(invoice.fee) : null,
        );
    } catch (error) {
      // The primary key is what makes a duplicate impossible; the error is translated so
      // callers branch on Byte's type rather than on a SQLite message.
      if (String(error).includes("UNIQUE") || String(error).includes("PRIMARY KEY")) {
        throw new DuplicateInvoiceError(invoice.invoiceId);
      }
      throw error;
    }
  }

  async get(invoiceId: string): Promise<StoredInvoice | undefined> {
    const row = this.#db
      .prepare("SELECT * FROM invoices WHERE invoice_id = ?")
      .get(invoiceId) as InvoiceRow | undefined;
    return row === undefined ? undefined : toInvoice(row);
  }

  /**
   * Atomically mark an invoice consumed.
   *
   * **A single conditional UPDATE.** `consumed_at IS NULL` is part of the statement, so the
   * test and the write are one operation and the row count is the answer: 1 means this call
   * consumed it, 0 means it was already consumed or never existed. There is no window
   * between deciding and writing for a second claim to slip through.
   */
  async consume(invoiceId: string, txid: string, at: number = Date.now()): Promise<boolean> {
    const result = this.#db
      .prepare(
        "UPDATE invoices SET consumed_at = ?, txid = ? WHERE invoice_id = ? AND consumed_at IS NULL",
      )
      .run(at, txid, invoiceId);

    return Number(result.changes) === 1;
  }

  async list(
    options: {
      limit?: number;
      cursor?: string;
      status?: "outstanding" | "consumed" | "expired";
    } = {},
  ): Promise<{ invoices: StoredInvoice[]; cursor?: string }> {
    const now = Date.now();
    const limit = clampLimit(options.limit);

    const where: string[] = [];
    const params: Array<string | number> = [];

    if (options.status === "consumed") {
      where.push("consumed_at IS NOT NULL");
    } else if (options.status === "outstanding") {
      where.push("consumed_at IS NULL AND expires_at > ?");
      params.push(now);
    } else if (options.status === "expired") {
      where.push("consumed_at IS NULL AND expires_at <= ?");
      params.push(now);
    }

    // Keyset pagination on (created_at, invoice_id): a plain OFFSET would skip or repeat
    // rows when an invoice is issued mid-page, and the tie-break on the id is what keeps
    // the order total when two invoices share a millisecond.
    if (options.cursor !== undefined) {
      const anchor = this.#db
        .prepare("SELECT created_at FROM invoices WHERE invoice_id = ?")
        .get(options.cursor) as { created_at: number } | undefined;
      if (anchor !== undefined) {
        where.push("(created_at < ? OR (created_at = ? AND invoice_id > ?))");
        params.push(anchor.created_at, anchor.created_at, options.cursor);
      }
    }

    const sql =
      "SELECT * FROM invoices" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY created_at DESC, invoice_id ASC LIMIT ?";

    // One extra row decides whether a next page exists, without a second COUNT query.
    const rows = this.#db.prepare(sql).all(...params, limit + 1) as unknown as InvoiceRow[];
    const page = rows.slice(0, limit).map(toInvoice);
    const cursor = rows.length > limit ? page.at(-1)?.invoiceId : undefined;

    return cursor === undefined ? { invoices: page } : { invoices: page, cursor };
  }

  /**
   * Drop expired, unconsumed invoices.
   *
   * `consumed_at IS NULL` is not an optimisation. A consumed record is what makes a replay
   * detectable, and deleting one re-opens the window it was closing.
   */
  async pruneExpired(before: number): Promise<number> {
    const result = this.#db
      .prepare("DELETE FROM invoices WHERE consumed_at IS NULL AND expires_at < ?")
      .run(before);
    return Number(result.changes);
  }

  /** Close the database, if this store opened it. */
  close(): void {
    if (this.#owned) this.#db.close();
  }
}

export class SqliteReceiptStore implements ReceiptStore {
  readonly #db: DatabaseSync;
  readonly #owned: boolean;

  constructor(options: SqliteStoreOptions) {
    this.#owned = options.database === undefined;
    this.#db = options.database ?? openByteDatabase(options.path);
  }

  get database(): DatabaseSync {
    return this.#db;
  }

  async put(receipt: ByteReceipt): Promise<void> {
    // Replace rather than refuse: re-verifying a payment should not fail because a receipt
    // for it already exists, and a receipt is a deterministic function of the payment.
    this.#db
      .prepare("INSERT OR REPLACE INTO receipts (invoice_id, body, stored_at) VALUES (?, ?, ?)")
      .run(receipt.invoiceId, JSON.stringify(receipt), Date.now());
  }

  async get(invoiceId: string): Promise<ByteReceipt | undefined> {
    const row = this.#db
      .prepare("SELECT body FROM receipts WHERE invoice_id = ?")
      .get(invoiceId) as { body: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.body) as ByteReceipt);
  }

  async list(
    options: { limit?: number; cursor?: string } = {},
  ): Promise<{ receipts: ByteReceipt[]; cursor?: string }> {
    const limit = clampLimit(options.limit);

    const where: string[] = [];
    const params: Array<string | number> = [];

    if (options.cursor !== undefined) {
      const anchor = this.#db
        .prepare("SELECT stored_at FROM receipts WHERE invoice_id = ?")
        .get(options.cursor) as { stored_at: number } | undefined;
      if (anchor !== undefined) {
        where.push("(stored_at < ? OR (stored_at = ? AND invoice_id > ?))");
        params.push(anchor.stored_at, anchor.stored_at, options.cursor);
      }
    }

    const sql =
      "SELECT body, invoice_id FROM receipts" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY stored_at DESC, invoice_id ASC LIMIT ?";

    const rows = this.#db.prepare(sql).all(...params, limit + 1) as unknown as Array<{
      body: string;
      invoice_id: string;
    }>;
    const page = rows.slice(0, limit).map((r) => JSON.parse(r.body) as ByteReceipt);
    const cursor = rows.length > limit ? page.at(-1)?.invoiceId : undefined;

    return cursor === undefined ? { receipts: page } : { receipts: page, cursor };
  }

  close(): void {
    if (this.#owned) this.#db.close();
  }
}

/**
 * Both stores over one database file.
 *
 * One file, one connection, one thing to back up. Closing it closes both.
 */
export function createSqliteStores(path: string): {
  invoices: SqliteInvoiceStore;
  receipts: SqliteReceiptStore;
  database: DatabaseSync;
  close: () => void;
} {
  const database = openByteDatabase(path);
  return {
    invoices: new SqliteInvoiceStore({ path, database }),
    receipts: new SqliteReceiptStore({ path, database }),
    database,
    close: () => database.close(),
  };
}
