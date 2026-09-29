/**
 * Storage interfaces.
 *
 * Byte ships a memory store for tests and development, and a Redis store for anything
 * that must survive a restart. Both satisfy these interfaces, and both are held to the
 * same test suite.
 *
 * See docs/SPEC.md §7.
 */

import type { StoredInvoice } from "./invoice.js";
import type { ByteReceipt } from "./receipt.js";

export interface InvoiceStore {
  /** Record a newly issued invoice. Throws if the ID already exists. */
  put(invoice: StoredInvoice): Promise<void>;

  get(invoiceId: string): Promise<StoredInvoice | undefined>;

  /**
   * Atomically mark an invoice consumed.
   *
   * **This is the replay defence, and it is why the interface exists.** A verifier that
   * reads an invoice, decides it is unconsumed, and then writes has a window between the
   * two in which a concurrent request can do the same — and both get served for one
   * payment. Implementations MUST make the test-and-set a single atomic operation: a
   * transaction in SQL, `SET ... NX` in Redis, a single synchronous block in memory.
   *
   * Returns `true` if this call consumed the invoice, `false` if it was already consumed.
   * A `false` return is a replay and the caller must not serve.
   */
  consume(invoiceId: string, txid: string, at?: number): Promise<boolean>;

  /** Invoices in reverse issue order, for the owner-only API. */
  list(options?: {
    limit?: number;
    cursor?: string;
    status?: "outstanding" | "consumed" | "expired";
  }): Promise<{ invoices: StoredInvoice[]; cursor?: string }>;

  /**
   * Drop expired, unconsumed invoices older than `before`.
   *
   * Consumed invoices are never dropped by this: their records are what makes replay
   * detectable, and forgetting one re-opens the window it was closing.
   */
  pruneExpired(before: number): Promise<number>;
}

export interface ReceiptStore {
  put(receipt: ByteReceipt): Promise<void>;
  get(invoiceId: string): Promise<ByteReceipt | undefined>;
  list(options?: {
    limit?: number;
    cursor?: string;
  }): Promise<{ receipts: ByteReceipt[]; cursor?: string }>;
}

/** Thrown by `put` when an invoice ID is already present. */
export class DuplicateInvoiceError extends Error {
  override readonly name = "DuplicateInvoiceError";
  constructor(invoiceId: string) {
    super(`invoice ${invoiceId} already exists`);
  }
}
