/**
 * ZIP-321 payment request URIs.
 *
 * A standard way to hand a wallet "pay this address, this amount, with this memo".
 * Byte emits one per invoice so that a human, or any ZIP-321-aware wallet, can settle a
 * Byte invoice without running Byte's client.
 *
 * Byte builds a single-output URI by default: the protocol fee is zero, so there is
 * usually no second output to encode. A facilitator fee adds one, and that is the only
 * reason the indexed multi-payment form exists here.
 *
 * `parseZip321` still refuses a multi-payment URI, and that strictness is deliberate: a
 * caller expecting one payment who is handed two and pays the first has underpaid, and
 * would not find out until the payee refused to serve. Code that can handle several
 * outputs asks for them by name, with `parseZip321Multi`.
 *
 * ## The grammar, from the ZIP
 *
 * `paramindex = "." NONZERO 0*3DIGIT` — so index 0 carries no suffix, indices run 1 to
 * 9999, and leading zeros are forbidden. `zcash:<address>?…` is equivalent to
 * `zcash:?address=<address>&…`. Any `req-` parameter a parser does not recognise
 * invalidates the whole URI, and no parameter may appear twice at the same index.
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
  return buildZip321Multi([payment]);
}

/**
 * Build a ZIP-321 URI for one or more payments.
 *
 * Payment 0's address goes in the path, which is the form every wallet displays most
 * legibly; the rest use `address.N`. Byte uses this for exactly one thing — a facilitator
 * fee as a second output — and a caller passing one payment gets a URI byte-identical to
 * the single-output form.
 */
export function buildZip321Multi(payments: Zip321Payment[]): string {
  if (payments.length === 0) {
    throw new ByteProtocolError("ZIP-321 requires at least one payment");
  }
  // 10,000 indices exist (0 and 1–9999), and nothing Byte builds comes close.
  if (payments.length > 10_000) {
    throw new ByteProtocolError("ZIP-321 allows at most 10000 payments");
  }

  const params: string[] = [];
  payments.forEach((payment, index) => {
    if (!payment.address) {
      throw new ByteProtocolError("ZIP-321 requires an address");
    }
    // Index 0 carries no suffix. Writing `.0` would be a leading-zero index, which the
    // grammar forbids outright.
    const suffix = index === 0 ? "" : `.${index}`;

    if (index > 0) params.push(`address${suffix}=${encodeQueryValue(payment.address)}`);
    params.push(`amount${suffix}=${zatToZecString(BigInt(payment.amountZat))}`);

    if (payment.memo !== undefined) {
      params.push(`memo${suffix}=${toBase64Url(utf8ToBytes(payment.memo))}`);
    }
    if (payment.label !== undefined) {
      params.push(`label${suffix}=${encodeQueryValue(payment.label)}`);
    }
    if (payment.message !== undefined) {
      params.push(`message${suffix}=${encodeQueryValue(payment.message)}`);
    }
  });

  return `${ZIP321_SCHEME}${payments[0]?.address ?? ""}?${params.join("&")}`;
}

/**
 * Parse a ZIP-321 URI that must contain exactly one payment.
 *
 * Strict by design. A caller expecting one payment, handed two, and paying the first has
 * underpaid — and would not find out until the payee refused to serve. Code that can
 * handle several outputs asks for them with `parseZip321Multi`.
 */
export function parseZip321(uri: string): Zip321Payment {
  const payments = parseZip321Multi(uri);
  if (payments.length > 1) {
    throw new ByteProtocolError(
      `this URI requests ${payments.length} payments; paying only the first would underpay. ` +
        "Use parseZip321Multi if you can settle all of them.",
    );
  }
  return payments[0] as Zip321Payment;
}

/**
 * Parse a ZIP-321 URI into every payment it requests, in index order.
 *
 * Strict everywhere it can be. A payment request that is not understood exactly must be
 * refused, not approximated: the cost of guessing is sending the wrong amount to the
 * wrong place.
 */
export function parseZip321Multi(uri: string): Zip321Payment[] {
  if (typeof uri !== "string" || !uri.startsWith(ZIP321_SCHEME)) {
    throw new ByteProtocolError("not a zcash: URI");
  }
  const rest = uri.slice(ZIP321_SCHEME.length);
  const split = rest.indexOf("?");
  const pathAddress = split === -1 ? rest : rest.slice(0, split);
  const query = split === -1 ? "" : rest.slice(split + 1);

  // `paramname[.paramindex]`, where paramindex is 1–9999 with no leading zero.
  const INDEXED = /^([a-zA-Z0-9+\-]+)(?:\.([1-9][0-9]{0,3}))?$/;

  // index -> param -> raw value
  const byIndex = new Map<number, Map<string, string>>();
  const at = (index: number): Map<string, string> => {
    let params = byIndex.get(index);
    if (params === undefined) {
      params = new Map();
      byIndex.set(index, params);
    }
    return params;
  };

  if (pathAddress !== "") {
    at(0).set("address", pathAddress);
  }

  for (const pair of query.split("&").filter(Boolean)) {
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    const key = decodeURIComponent(rawKey);

    const match = INDEXED.exec(key);
    if (match === null) {
      // Catches `amount.0` and `amount.01`: both are leading-zero indices, which the
      // grammar forbids, and both would otherwise silently collide with index 0.
      throw new ByteProtocolError(`malformed ZIP-321 parameter name ${key}`);
    }
    const name = match[1] as string;
    const index = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);

    // ZIP-321 requires a parser to refuse any `req-` parameter it does not understand.
    if (name.startsWith("req-")) {
      throw new ByteProtocolError(`unsupported required ZIP-321 parameter ${key}`);
    }

    const params = at(index);
    if (params.has(name)) {
      throw new ByteProtocolError(`duplicate ZIP-321 parameter ${key}`);
    }
    params.set(name, rawValue);
  }

  const indices = [...byIndex.keys()].sort((a, b) => a - b);
  if (indices.length === 0) {
    throw new ByteProtocolError("ZIP-321 URI requests no payments");
  }

  return indices.map((index) => {
    const params = byIndex.get(index) as Map<string, string>;
    const label = index === 0 ? "" : `.${index}`;

    const rawAddress = params.get("address");
    if (rawAddress === undefined || rawAddress === "") {
      // The ZIP is explicit: any index carrying non-address parameters must carry an
      // address too. Without one there is nowhere to send this leg.
      throw new ByteProtocolError(`ZIP-321 payment${label} has no address`);
    }
    const address = decodeURIComponent(rawAddress);

    const rawAmount = params.get("amount");
    if (rawAmount === undefined) {
      throw new ByteProtocolError(`ZIP-321 payment${label} has no amount`);
    }

    const payment: Zip321Payment = {
      address,
      amountZat: zecStringToZat(decodeURIComponent(rawAmount)).toString(10),
    };

    const rawMemo = params.get("memo");
    if (rawMemo !== undefined) {
      let decoded: Uint8Array;
      try {
        decoded = fromBase64Url(rawMemo);
      } catch (cause) {
        throw new ByteProtocolError(`ZIP-321 memo${label} is not valid base64url`, { cause });
      }
      try {
        payment.memo = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
      } catch (cause) {
        throw new ByteProtocolError(`ZIP-321 memo${label} is not valid UTF-8`, { cause });
      }
    }

    const rawLabel = params.get("label");
    if (rawLabel !== undefined) payment.label = decodeURIComponent(rawLabel);

    const rawMessage = params.get("message");
    if (rawMessage !== undefined) payment.message = decodeURIComponent(rawMessage);

    return payment;
  });
}
