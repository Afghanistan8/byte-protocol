/**
 * Byte-level helpers.
 *
 * Thin wrappers over @noble/hashes utilities, kept in one place so the rest of the
 * package never reaches for a subpath import directly. Note that @noble/hashes v2
 * requires the `.js` extension on subpath imports.
 */

import { bytesToHex, hexToBytes, utf8ToBytes, randomBytes } from "@noble/hashes/utils.js";

export { bytesToHex, hexToBytes, utf8ToBytes, randomBytes };

const HEX_RE = /^[0-9a-f]*$/;

/** True when `value` is lowercase hex of exactly `byteLength` bytes. */
export function isHex(value: unknown, byteLength?: number): value is string {
  if (typeof value !== "string") return false;
  if (value.length % 2 !== 0) return false;
  if (byteLength !== undefined && value.length !== byteLength * 2) return false;
  return HEX_RE.test(value);
}

/**
 * Constant-time comparison of two strings.
 *
 * Used for memo bindings and API keys. A plain `===` leaks, through timing, how many
 * leading characters an attacker got right, which is enough to forge a binding one
 * character at a time.
 *
 * Length is compared first and non-constant-time. That is deliberate: the length of a
 * binding is fixed and public, so it carries no secret.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Encode bytes as unpadded base64url (RFC 4648 §5). */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Decode unpadded base64url. Throws if the input is not valid base64url. */
export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new TypeError("not valid base64url");
  }
  return new Uint8Array(Buffer.from(text, "base64url"));
}
