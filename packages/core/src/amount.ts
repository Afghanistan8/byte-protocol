/**
 * Zatoshi amounts.
 *
 * Amounts cross the wire as base-10 integer strings, never as JSON numbers. The maximum
 * supply is 2.1e15 zatoshis, which exceeds `Number.MAX_SAFE_INTEGER` (9.007e15) by less
 * than an order of magnitude — safe today, but a single multiplication is enough to
 * leave the safe range silently. Strings in, bigint for arithmetic, strings out.
 */

import { ByteProtocolError } from "./errors.js";

export const ZATOSHIS_PER_ZEC = 100_000_000n;

/** Maximum supply in zatoshis: 21,000,000 ZEC. */
export const MAX_ZATOSHIS = 21_000_000n * ZATOSHIS_PER_ZEC;

const INTEGER_RE = /^(0|[1-9][0-9]*)$/;

/**
 * Parse a zatoshi amount.
 *
 * Rejects leading zeroes, signs, decimal points and exponents outright rather than
 * coercing them. A string like `"1e8"` or `"+100"` means someone's encoder is wrong, and
 * silently accepting it would put a different number on the chain than in the invoice.
 */
export function parseZat(value: string): bigint {
  if (typeof value !== "string" || !INTEGER_RE.test(value)) {
    throw new ByteProtocolError(
      `amount must be a base-10 integer string of zatoshis, got ${JSON.stringify(value)}`,
    );
  }
  const zat = BigInt(value);
  if (zat > MAX_ZATOSHIS) {
    throw new ByteProtocolError(`amount ${value} exceeds the maximum supply`);
  }
  return zat;
}

/** True when `value` is a well-formed zatoshi amount string. */
export function isZat(value: unknown): value is string {
  if (typeof value !== "string" || !INTEGER_RE.test(value)) return false;
  return BigInt(value) <= MAX_ZATOSHIS;
}

/** Render zatoshis as the canonical integer string. */
export function formatZat(zat: bigint): string {
  if (zat < 0n) throw new ByteProtocolError("amount cannot be negative");
  if (zat > MAX_ZATOSHIS) throw new ByteProtocolError("amount exceeds the maximum supply");
  return zat.toString(10);
}

/**
 * Render zatoshis as decimal ZEC, for ZIP-321 URIs and display.
 *
 * ZIP-321 carries `amount` in ZEC with at most 8 decimal places, not in zatoshis. Done
 * with string manipulation rather than floating point: 0.1 ZEC is not representable as
 * a double, and rounding a payment amount is not an acceptable failure mode.
 */
export function zatToZecString(zat: bigint): string {
  if (zat < 0n) throw new ByteProtocolError("amount cannot be negative");
  const whole = zat / ZATOSHIS_PER_ZEC;
  const fraction = zat % ZATOSHIS_PER_ZEC;
  if (fraction === 0n) return whole.toString(10);
  const padded = fraction.toString(10).padStart(8, "0").replace(/0+$/, "");
  return `${whole.toString(10)}.${padded}`;
}

/** Parse decimal ZEC (as used by ZIP-321) into zatoshis, exactly. */
export function zecStringToZat(value: string): bigint {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/.exec(value);
  if (!match) {
    throw new ByteProtocolError(
      `ZEC amount must be decimal with at most 8 places, got ${JSON.stringify(value)}`,
    );
  }
  const whole = BigInt(match[1] as string);
  const fraction = BigInt((match[2] ?? "").padEnd(8, "0"));
  const zat = whole * ZATOSHIS_PER_ZEC + fraction;
  if (zat > MAX_ZATOSHIS) {
    throw new ByteProtocolError(`amount ${value} exceeds the maximum supply`);
  }
  return zat;
}
