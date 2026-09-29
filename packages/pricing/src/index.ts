/**
 * @byte-protocol/pricing
 *
 * ZEC/USD price sources, and the guards that decide whether a price may be used at all.
 *
 * A merchant prices in USD; Byte settles in ZEC. The conversion happens once, at issue
 * time, and is locked into the invoice — see `core/src/price.ts` for why re-pricing at
 * verification is unusable.
 */

export * from "./sources.js";
export * from "./guarded.js";
