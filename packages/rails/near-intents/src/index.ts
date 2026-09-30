/**
 * @byte-protocol/rail-near-intents
 *
 * Funding from another chain through NEAR Intents.
 *
 * NEAR Intents supports ZEC at transparent addresses only, so this rail's Zcash leg is a
 * public transaction. Byte does not present it as private. See docs/RAILS.md.
 */

export * from "@byte-protocol/rails";
export * from "./rail.js";
export * from "./quote-signature.js";
