/**
 * The Byte memo codec.
 *
 * A Zcash memo is a fixed 512-byte field carried inside a shielded output, encrypted to
 * the recipient. Byte uses it to bind a payment to the invoice it settles, so that a
 * payee can recognise its own invoice from the note alone.
 *
 * Wire format, UTF-8:
 *
 *     BYTE1|<invoiceId>|<binding>
 *
 * `binding` is HMAC-SHA256 over the invoice's identifying fields under a secret only the
 * payee holds, truncated to 16 bytes. It is not a confidentiality measure — the memo is
 * already encrypted to the recipient — it is an authenticity measure. It lets a payee
 * confirm "I issued this" from its own secret, without a database lookup, and stops a
 * third party from minting memos that a payee's verifier would treat as its own.
 *
 * See docs/SPEC.md §6.
 */

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, isHex, timingSafeEqual, utf8ToBytes } from "./bytes.js";
import { ByteMemoError } from "./errors.js";

/** Every Zcash memo field is exactly this many bytes. Not a maximum — a fixed size. */
export const MEMO_SIZE = 512;

/** Version tag. A verifier rejects anything else outright. */
export const MEMO_VERSION = "BYTE1";

/** Bytes of HMAC output kept. 128 bits is ample for an authenticity tag. */
export const BINDING_BYTES = 16;

/** Invoice identifiers are 128 bits, rendered as 32 lowercase hex characters. */
export const INVOICE_ID_BYTES = 16;

/**
 * Minimum length of a memo secret.
 *
 * HMAC accepts any key length, but a short one is brute-forceable offline by anyone
 * holding a single memo and the invoice fields it commits to — which the payer always
 * has. Enforced rather than documented.
 */
export const MIN_SECRET_BYTES = 32;

export interface MemoBinding {
  invoiceId: string;
  /** Zatoshis, as the canonical integer string. */
  amountZat: string;
  /** The invoice's diversified unified address. */
  payTo: string;
}

export interface ParsedMemo {
  version: typeof MEMO_VERSION;
  invoiceId: string;
  binding: string;
}

function assertSecret(secret: Uint8Array): void {
  if (secret.length < MIN_SECRET_BYTES) {
    throw new ByteMemoError(
      `memo secret must be at least ${MIN_SECRET_BYTES} bytes, got ${secret.length}`,
    );
  }
}

/**
 * Compute the binding tag.
 *
 * Fields are joined with `\u0000`, a byte that cannot occur in any of them. Concatenating
 * without a separator would let different field splits produce the same input — an
 * invoice for 1 ZEC to address `Ab` and one for 11 ZEC to address `b` would collide —
 * and a binding that collides is a binding that can be replayed onto another invoice.
 */
export function computeBinding(secret: Uint8Array, fields: MemoBinding): string {
  assertSecret(secret);
  const preimage = utf8ToBytes(
    `${fields.invoiceId}\u0000${fields.amountZat}\u0000${fields.payTo}`,
  );
  return bytesToHex(hmac(sha256, secret, preimage)).slice(0, BINDING_BYTES * 2);
}

/** Build the memo text for an invoice. */
export function encodeMemo(secret: Uint8Array, fields: MemoBinding): string {
  if (!isHex(fields.invoiceId, INVOICE_ID_BYTES)) {
    throw new ByteMemoError(
      `invoiceId must be ${INVOICE_ID_BYTES * 2} lowercase hex characters`,
    );
  }
  const memo = `${MEMO_VERSION}|${fields.invoiceId}|${computeBinding(secret, fields)}`;
  // Guard the invariant rather than trusting the arithmetic above.
  if (utf8ToBytes(memo).length > MEMO_SIZE) {
    throw new ByteMemoError(`memo is ${memo.length} bytes, over the ${MEMO_SIZE} limit`);
  }
  return memo;
}

/**
 * Parse memo text.
 *
 * Deliberately strict. Anything that is not exactly the expected shape is rejected
 * rather than salvaged: a memo is attacker-controlled input arriving from the chain, and
 * a lenient parser here is a way in.
 */
export function parseMemo(text: unknown): ParsedMemo {
  if (typeof text !== "string") {
    throw new ByteMemoError("memo is not a string");
  }
  const parts = text.split("|");
  if (parts.length !== 3) {
    throw new ByteMemoError(`memo must have 3 fields, got ${parts.length}`);
  }
  const [version, invoiceId, binding] = parts as [string, string, string];
  if (version !== MEMO_VERSION) {
    throw new ByteMemoError(`unknown memo version ${JSON.stringify(version)}`);
  }
  if (!isHex(invoiceId, INVOICE_ID_BYTES)) {
    throw new ByteMemoError("memo invoiceId is not 32 lowercase hex characters");
  }
  if (!isHex(binding, BINDING_BYTES)) {
    throw new ByteMemoError("memo binding is not 32 lowercase hex characters");
  }
  return { version: MEMO_VERSION, invoiceId, binding };
}

/**
 * Check a memo against the invoice it claims to settle.
 *
 * Returns a boolean rather than throwing, because a failure here is an ordinary
 * verification outcome (`invalid_payment`) and not an exceptional condition. A malformed
 * memo is false, never an exception — a payee scanning notes must not be knocked over by
 * whatever arbitrary bytes someone chose to send it.
 */
export function verifyMemo(
  secret: Uint8Array,
  text: unknown,
  fields: MemoBinding,
): boolean {
  let parsed: ParsedMemo;
  try {
    parsed = parseMemo(text);
  } catch {
    return false;
  }
  if (!timingSafeEqual(parsed.invoiceId, fields.invoiceId)) return false;
  let expected: string;
  try {
    expected = computeBinding(secret, fields);
  } catch {
    return false;
  }
  return timingSafeEqual(parsed.binding, expected);
}

/**
 * Encode memo text into the fixed 512-byte field, null-padded.
 *
 * Matches what `zcash_protocol::memo::MemoBytes::from_bytes` does with a short slice.
 * Note that an empty memo and an absent memo are different things at the protocol level;
 * Byte always writes text, so it never constructs the "no memo" form.
 */
export function toMemoBytes(text: string): Uint8Array {
  const encoded = utf8ToBytes(text);
  if (encoded.length > MEMO_SIZE) {
    throw new ByteMemoError(`memo is ${encoded.length} bytes, over the ${MEMO_SIZE} limit`);
  }
  const out = new Uint8Array(MEMO_SIZE);
  out.set(encoded);
  return out;
}

/**
 * Recover memo text from the 512-byte field.
 *
 * Trailing null padding is stripped. Invalid UTF-8 throws rather than producing
 * replacement characters, so a corrupted memo fails verification instead of quietly
 * turning into a string that cannot match anything.
 */
export function fromMemoBytes(bytes: Uint8Array): string {
  if (bytes.length !== MEMO_SIZE) {
    throw new ByteMemoError(`memo field must be ${MEMO_SIZE} bytes, got ${bytes.length}`);
  }
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return decoder.decode(bytes.subarray(0, end));
  } catch (cause) {
    throw new ByteMemoError("memo bytes are not valid UTF-8", { cause });
  }
}
