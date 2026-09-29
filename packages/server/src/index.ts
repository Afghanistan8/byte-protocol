/**
 * @byte-protocol/server
 *
 * Issue invoices, verify payments. Framework-agnostic: `byteGate` adapts this to Express
 * and Hono, and the adapters package wires it into payment frameworks.
 */

export * from "./issuer.js";
export * from "./verifier.js";
