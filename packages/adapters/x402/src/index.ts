/**
 * @byte-protocol/adapter-x402
 *
 * Byte spoken as x402 v2: `scheme: "exact"` on a Zcash network, with Byte's invoice
 * specifics in `extra`. The same shape the Lightning scheme uses, so this is a
 * contribution to x402 rather than a dialect of it.
 */

export * from "./mapping.js";
export * from "./gate.js";
