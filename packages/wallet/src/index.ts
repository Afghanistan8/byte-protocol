/**
 * @byte-protocol/wallet
 *
 * The wallet contract Byte codes against, plus a deterministic mock implementation.
 *
 * Two backends: `WalletdWallet`, which talks to the `byte-walletd` sidecar over its localhost
 * JSON API and therefore to a real chain, and `MockWallet`, which is deterministic and models
 * the failure modes. Everything above this package runs unchanged against either.
 */

export * from "./types.js";
export * from "./wallet.js";
export * from "./mock.js";
export * from "./autoshield.js";
export * from "./walletd.js";
