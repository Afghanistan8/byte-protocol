/**
 * @byte-protocol/stores
 *
 * Implementations of core's `InvoiceStore` and `ReceiptStore`: an in-memory pair for tests
 * and development, and a durable SQLite pair for anything that must survive a restart.
 *
 * Both are held to the same contract suite, including the atomicity of `consume`, which is
 * the replay defence. Only the SQLite pair survives a restart, and the suite asserts that
 * difference rather than leaving it implied.
 */

export * from "./memory.js";
export * from "./sqlite.js";
