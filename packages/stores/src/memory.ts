/**
 * In-memory stores.
 *
 * For tests, development, and single-process deployments that can tolerate losing
 * outstanding invoices on restart. Anything else needs a durable store, which Byte does
 * not yet ship — see the warning on `MemoryInvoiceStore` and docs/ROADMAP.md.
 */

import {
  DuplicateInvoiceError,
  type ByteReceipt,
  type InvoiceStore,
  type ReceiptStore,
  type StoredInvoice,
} from "@byte-protocol/core";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/**
 * An invoice store held in a `Map`.
 *
 * **Restarting loses every consumed-invoice record**, which re-opens the replay window for
 * any invoice still inside its expiry. That is stated here rather than buried in a
 * README: an operator who chooses this store in production has chosen that.
 */
export class MemoryInvoiceStore implements InvoiceStore {
  readonly #invoices = new Map<string, StoredInvoice>();

  async put(invoice: StoredInvoice): Promise<void> {
    if (this.#invoices.has(invoice.invoiceId)) {
      throw new DuplicateInvoiceError(invoice.invoiceId);
    }
    // Copy on write. Holding the caller's object would let a later mutation of it change
    // what the store believes, including the amount an invoice was issued for.
    this.#invoices.set(invoice.invoiceId, { ...invoice });
  }

  async get(invoiceId: string): Promise<StoredInvoice | undefined> {
    const invoice = this.#invoices.get(invoiceId);
    return invoice ? { ...invoice } : undefined;
  }

  /**
   * Atomically mark an invoice consumed.
   *
   * The test-and-set below is synchronous and contains no `await`. That is what makes it
   * atomic: JavaScript runs it to completion before any other task on this thread can
   * observe the map. Introducing an `await` between the read and the write — to log, to
   * call a hook, to do anything at all — would open the replay window this method exists
   * to close.
   */
  async consume(invoiceId: string, txid: string, at: number = Date.now()): Promise<boolean> {
    const invoice = this.#invoices.get(invoiceId);
    if (invoice === undefined) return false;
    if (invoice.consumedAt !== undefined) return false;

    this.#invoices.set(invoiceId, { ...invoice, consumedAt: at, txid });
    return true;
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

    let all = [...this.#invoices.values()].sort((a, b) => b.createdAt - a.createdAt);

    if (options.status === "consumed") {
      all = all.filter((i) => i.consumedAt !== undefined);
    } else if (options.status === "outstanding") {
      all = all.filter((i) => i.consumedAt === undefined && now < i.expiresAt);
    } else if (options.status === "expired") {
      all = all.filter((i) => i.consumedAt === undefined && now >= i.expiresAt);
    }

    const start = options.cursor ? all.findIndex((i) => i.invoiceId === options.cursor) + 1 : 0;
    const page = all.slice(start, start + limit).map((i) => ({ ...i }));
    const next = start + limit < all.length ? page.at(-1)?.invoiceId : undefined;

    return next === undefined ? { invoices: page } : { invoices: page, cursor: next };
  }

  /**
   * Drop expired, unconsumed invoices issued before `before`.
   *
   * Consumed invoices are never dropped. Their records are what makes a replay detectable,
   * and forgetting one re-opens the window it was closing.
   */
  async pruneExpired(before: number): Promise<number> {
    let removed = 0;
    for (const [id, invoice] of this.#invoices) {
      if (invoice.consumedAt === undefined && invoice.expiresAt < before) {
        this.#invoices.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Number of invoices held. For tests and the owner-only API. */
  get size(): number {
    return this.#invoices.size;
  }

  clear(): void {
    this.#invoices.clear();
  }
}

export class MemoryReceiptStore implements ReceiptStore {
  readonly #receipts = new Map<string, ByteReceipt>();

  async put(receipt: ByteReceipt): Promise<void> {
    this.#receipts.set(receipt.invoiceId, { ...receipt });
  }

  async get(invoiceId: string): Promise<ByteReceipt | undefined> {
    const receipt = this.#receipts.get(invoiceId);
    return receipt ? { ...receipt } : undefined;
  }

  async list(
    options: { limit?: number; cursor?: string } = {},
  ): Promise<{ receipts: ByteReceipt[]; cursor?: string }> {
    const limit = clampLimit(options.limit);
    const all = [...this.#receipts.values()];
    const start = options.cursor ? all.findIndex((r) => r.invoiceId === options.cursor) + 1 : 0;
    const page = all.slice(start, start + limit).map((r) => ({ ...r }));
    const next = start + limit < all.length ? page.at(-1)?.invoiceId : undefined;

    return next === undefined ? { receipts: page } : { receipts: page, cursor: next };
  }

  get size(): number {
    return this.#receipts.size;
  }

  clear(): void {
    this.#receipts.clear();
  }
}
