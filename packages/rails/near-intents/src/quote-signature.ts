/**
 * Verifying that a 1Click quote was actually signed by 1Click.
 *
 * ## Why this matters more than it looks
 *
 * A quote hands back a `depositAddress`, and the caller then sends real value to it. If the
 * response can be forged or swapped in transit, that address can be an attacker's. The
 * signature is what ties an address to the service that reserved it, and the 1Click docs
 * say the signed response should be kept to settle any dispute about a deposit.
 *
 * ## The algorithm, and where each part comes from
 *
 * Documented at docs.near-intents.org ("Verify Quote Signatures"): the signed content is a
 * Base58 SHA-256 of a deterministic JSON object built from the request, the quote and the
 * timestamp. The page does **not** state the key or the signature algorithm, so those come
 * from the published SDK's `verifyQuoteSignature` (`@defuse-protocol/one-click-sdk-typescript`
 * 0.1.26, 22 September 2026), which is what 1Click itself ships:
 *
 * 1. Select a fixed set of fields from `quoteRequest` and from `quote` (below). The set is
 *    not "everything": echoed fields the service adds itself, such as `appFees`, are left out.
 * 2. `stringify({ ...request, ...quote, timestamp })` with **sorted keys**, no whitespace,
 *    and `undefined` values omitted (the behaviour of `json-stable-stringify`).
 * 3. SHA-256, then **Base58-encode the digest**.
 * 4. The message that is verified is the UTF-8 bytes of that **Base58 string** — not the raw
 *    digest. Easy to get wrong, and a wrong guess fails closed and looks like a forgery.
 * 5. Ed25519, against a fixed 1Click manager key, both encoded `ed25519:<base58>`.
 *
 * ## How this was validated
 *
 * Not against a signature I produced myself, which would prove only that my code agrees with
 * my code. `fixtures/live-dry-quote-2026-09-29.json` is a **real signed response** from the
 * live API, captured with a dry request carrying only public example values. It verifies.
 *
 * ## What is and is not covered
 *
 * Quotes, dry and live. The docs' index describes "quote and status payloads", but the page
 * documents only the quote algorithm and the SDK ships no status verifier, so Byte verifies
 * quotes and does **not** claim to verify status responses.
 */

import { sha256, utf8ToBytes, verifyEd25519 } from "@byte-protocol/core";

/**
 * 1Click's manager public key, as published in the SDK.
 *
 * Overridable, because a rotated key would otherwise make every genuine quote look forged.
 * That fails closed, which is the safe direction, but it should be fixable by configuration
 * rather than by a release.
 */
export const ONE_CLICK_MANAGER_PUB_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

const ED25519_PREFIX = "ed25519:";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet) encode. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);

  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return "1".repeat(zeros) + encoded;
}

/** Base58 decode. Throws on any character outside the alphabet. */
export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;

  let value = 0n;
  for (const char of text) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit === -1) throw new TypeError(`not a base58 character: ${JSON.stringify(char)}`);
    value = value * 58n + BigInt(digit);
  }

  const body: number[] = [];
  while (value > 0n) {
    body.unshift(Number(value % 256n));
    value /= 256n;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

/** Strip an optional `ed25519:` prefix and decode the rest as base58. */
function decodeEd25519(value: string): Uint8Array {
  return base58Decode(value.startsWith(ED25519_PREFIX) ? value.slice(ED25519_PREFIX.length) : value);
}

/**
 * Deterministic JSON: keys sorted, no whitespace, `undefined` object values omitted.
 *
 * Reproduces `json-stable-stringify` with no options, because the hash has to match theirs
 * byte for byte. Written out rather than depended on: it is twenty lines, and a payment
 * library should not take a dependency for something it can state exactly.
 */
export function stableStringify(value: unknown): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    // An `undefined` array element becomes `null`, as in JSON.stringify.
    return `[${value.map((item) => stableStringify(item) ?? "null").join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = stableStringify(record[key]);
      // Omitted entirely, not written as null: this is what makes the fields the SDK sets
      // to `void 0` drop out of the hash.
      if (encoded === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(",")}}`;
  }

  return undefined;
}

type Loose = Record<string, unknown>;

/** A value counts as absent when it is falsy, matching the SDK's `x ? x : void 0`. */
const orAbsent = (value: unknown): unknown => (value ? value : undefined);

/** The fields of `quoteRequest` that are signed. */
function signedRequest(quoteRequest: Loose): Loose {
  return {
    dry: quoteRequest.dry,
    swapType: quoteRequest.swapType,
    slippageTolerance: quoteRequest.slippageTolerance,
    originAsset: quoteRequest.originAsset,
    depositType: quoteRequest.depositType,
    destinationAsset: quoteRequest.destinationAsset,
    amount: quoteRequest.amount,
    refundTo: quoteRequest.refundTo,
    refundType: quoteRequest.refundType,
    recipient: quoteRequest.recipient,
    recipientType: quoteRequest.recipientType,
    deadline: quoteRequest.deadline,
    quoteWaitingTimeMs: orAbsent(quoteRequest.quoteWaitingTimeMs),
    referral: orAbsent(quoteRequest.referral),
    virtualChainRecipient: orAbsent(quoteRequest.virtualChainRecipient),
    virtualChainRefundRecipient: orAbsent(quoteRequest.virtualChainRefundRecipient),
    customRecipientMsg: orAbsent(quoteRequest.customRecipientMsg),
    // Present in the echoed request but deliberately not signed. Listed as `undefined` so
    // the omission is visible here rather than implied by a field's absence.
    sessionId: undefined,
    connectedWallets: undefined,
    correlationId: undefined,
    appFees: undefined,
    partnerId: undefined,
    userAccountId: undefined,
    depositMode: undefined,
  };
}

/** The fields of `quote` that are signed. A dry quote signs fewer: it has no address yet. */
function signedQuote(quote: Loose, dry: boolean): Loose {
  const priced = {
    amountIn: quote.amountIn,
    amountInFormatted: quote.amountInFormatted,
    amountInUsd: quote.amountInUsd,
    minAmountIn: quote.minAmountIn,
    amountOut: quote.amountOut,
    amountOutFormatted: quote.amountOutFormatted,
    amountOutUsd: quote.amountOutUsd,
    minAmountOut: quote.minAmountOut,
  };
  if (dry) return priced;

  return {
    ...priced,
    depositAddress: orAbsent(quote.depositAddress),
    depositMemo: orAbsent(quote.depositMemo),
    deadline: orAbsent(quote.deadline),
    timeWhenInactive: orAbsent(quote.timeWhenInactive),
    timeEstimate: orAbsent(quote.timeEstimate),
    refundFee: orAbsent(quote.refundFee),
    withdrawFee: orAbsent(quote.withdrawFee),
  };
}

/** The Base58 SHA-256 the signature covers. Throws if the response is not shaped like a quote. */
export function quoteHash(response: unknown): string {
  const r = response as Loose;
  const quoteRequest = r.quoteRequest as Loose | undefined;
  const quote = r.quote as Loose | undefined;
  if (quoteRequest === undefined || quote === undefined || typeof r.timestamp !== "string") {
    throw new TypeError("not a 1Click quote response");
  }

  const payload = stableStringify({
    ...signedRequest(quoteRequest),
    ...signedQuote(quote, quoteRequest.dry === true),
    timestamp: r.timestamp,
  });
  if (payload === undefined) throw new TypeError("quote payload could not be serialized");

  return base58Encode(sha256(utf8ToBytes(payload)));
}

export interface VerifyQuoteOptions {
  /** Override the manager key. Defaults to {@link ONE_CLICK_MANAGER_PUB_KEY}. */
  publicKey?: string;
}

/**
 * True only if `response` carries a valid 1Click signature over its own contents.
 *
 * Never throws. A quote arrives from the network, so malformed input is the ordinary case,
 * and every malformed shape reads as "not verified" rather than as an exception a caller
 * might catch and carry on past.
 */
export function verifyQuoteSignature(response: unknown, options: VerifyQuoteOptions = {}): boolean {
  try {
    const signature = (response as Loose).signature;
    if (typeof signature !== "string") return false;

    return verifyEd25519(
      decodeEd25519(signature),
      utf8ToBytes(quoteHash(response)),
      decodeEd25519(options.publicKey ?? ONE_CLICK_MANAGER_PUB_KEY),
    );
  } catch {
    return false;
  }
}
