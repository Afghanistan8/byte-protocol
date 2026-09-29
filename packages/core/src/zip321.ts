/**
 * ZIP-321 payment request URIs.
 *
 * A standard way to hand a wallet "pay this address, this amount, with this memo".
 * Byte emits one per invoice so that a human, or any ZIP-321-aware wallet, can settle a
 * Byte invoice without running Byte's client.
 *
 * Byte always builds single-output URIs. The protocol fee is zero, so there is never a
 * second output to encode. The parser accepts a single payment and rejects the indexed
 * multi-payment form explicitly rather than silently reading only the first leg — paying
 * one output of a two-output request underpays.
 */

import { zatToZecString, zecStringToZat } from "./amount.js";
import { fromBase64Url, toBase64Url, utf8ToBytes } from "./bytes.js";
import { ByteProtocolError } from "./errors.js";

export const ZIP321_SCHEME = "zcash:";

export interface Zip321Payment {
  address: string;
  /** Zatoshis, canonical integer string. */
  amountZat: string;
  /** Memo text. Encoded to base64url of its UTF-8 bytes in the URI. */
  memo?: string;
  label?: string;
  message?: string;
}

/**
 * ZIP-321 percent-encoding.
 *
 * `encodeURIComponent` leaves `!'()*` unescaped. They are legal in a query value, but
 * encoding them keeps output byte-identical across implementations, which matters because
 * this URI is displayed to humans who may compare it against another wallet's rendering.
 */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Build a ZIP-321 URI for a single payment. */
export function buildZip321(payment: Zip321Payment): string {
  if (!payment.address) {
    throw new ByteProtocolError("ZIP-321 requires an address");
  }
  const zat = BigInt(payment.amountZat);
  const params: string[] = [`amount=${zatToZecString(zat)}`];

  if (payment.memo !== undefined) {
    params.push(`memo=${toBase64Url(utf8ToBytes(payment.memo))}`);
  }
  if (payment.label !== undefined) {
    params.push(`label=${encodeQueryValue(payment.label)}`);
  }
  if (payment.message !== undefined) {
    params.push(`message=${encodeQueryValue(payment.message)}`);
  }
  return `${ZIP321_SCHEME}${payment.address}?${params.join("&")}`;
}

/**
 * Parse a single-payment ZIP-321 URI.
 *
 * Strict by design. A payment request that is not understood exactly must be refused, not
 * approximated — the cost of guessing is sending the wrong amount to the wrong place.
 */
export function parseZip321(uri: string): Zip321Payment {
  if (typeof uri !== "string" || !uri.startsWith(ZIP321_SCHEME)) {
    throw new ByteProtocolError("not a zcash: URI");
  }
  const rest = uri.slice(ZIP321_SCHEME.length);
  const split = rest.indexOf("?");
  const address = split === -1 ? rest : rest.slice(0, split);
  const query = split === -1 ? "" : rest.slice(split + 1);

  if (!address) {
    throw new ByteProtocolError(
      "ZIP-321 URIs without an address in the path are not supported",
    );
  }

  const seen = new Map<string, string>();
  for (const pair of query.split("&").filter(Boolean)) {
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    const key = decodeURIComponent(rawKey);

    // `name.N` is the indexed multi-payment form.
    if (/\.\d+$/.test(key)) {
      throw new ByteProtocolError(
        "multi-payment ZIP-321 URIs are not supported; Byte issues one output per invoice",
      );
    }
    // ZIP-321 requires that a parser refuse any `req-` parameter it does not understand.
    if (key.startsWith("req-")) {
      throw new ByteProtocolError(`unsupported required ZIP-321 parameter ${key}`);
    }
    if (seen.has(key)) {
      throw new ByteProtocolError(`duplicate ZIP-321 parameter ${key}`);
    }
    seen.set(key, rawValue);
  }

  const rawAmount = seen.get("amount");
  if (rawAmount === undefined) {
    throw new ByteProtocolError("ZIP-321 URI has no amount");
  }

  const payment: Zip321Payment = {
    address,
    amountZat: zecStringToZat(decodeURIComponent(rawAmount)).toString(10),
  };

  const rawMemo = seen.get("memo");
  if (rawMemo !== undefined) {
    let decoded: Uint8Array;
    try {
      decoded = fromBase64Url(rawMemo);
    } catch (cause) {
      throw new ByteProtocolError("ZIP-321 memo is not valid base64url", { cause });
    }
    try {
      payment.memo = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    } catch (cause) {
      throw new ByteProtocolError("ZIP-321 memo is not valid UTF-8", { cause });
    }
  }

  const rawLabel = seen.get("label");
  if (rawLabel !== undefined) payment.label = decodeURIComponent(rawLabel);

  const rawMessage = seen.get("message");
  if (rawMessage !== undefined) payment.message = decodeURIComponent(rawMessage);

  return payment;
}
