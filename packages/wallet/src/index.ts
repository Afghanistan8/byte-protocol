/**
 * @byte-protocol/wallet
 *
 * The wallet contract Byte codes against, plus a deterministic mock implementation.
 *
 * Real backends live alongside this: `byte-walletd` (the Rust sidecar on librustzcash)
 * is the supported one. Anything not listed here is not implemented.
 */

export * from "./types.js";
export * from "./wallet.js";
export * from "./mock.js";
