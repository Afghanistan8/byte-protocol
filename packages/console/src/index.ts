/**
 * @byte-protocol/console
 *
 * The owner-only JSON API, and a single-file console UI that reads it.
 *
 * Both are owner-only. The console reports invoice amounts, transaction identifiers and
 * balances — exactly what Byte keeps off the chain — so there is no unauthenticated route.
 */

export * from "./api.js";
export * from "./ui.js";
export * from "./server.js";
