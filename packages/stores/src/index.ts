/**
 * @byte-protocol/stores
 *
 * Implementations of core's `InvoiceStore` and `ReceiptStore`. Both are held to the same
 * behaviour, including the atomicity of `consume`, which is the replay defence.
 */

export * from "./memory.js";
