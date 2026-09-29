/**
 * `createByteFetch` — a `fetch` that pays.
 *
 * Wraps the standard fetch. A `402` carrying Byte payment requirements is settled and the
 * request retried; everything else passes through untouched.
 *
 * The wrapper is deliberately thin. An agent should be able to swap `fetch` for this and
 * have paid endpoints start working, without learning a second HTTP API.
 */

import {
  ByteProtocolError,
  type BytePaymentRequirements,
} from "@byte-protocol/core";
import type { SpendingWallet } from "@byte-protocol/wallet";
import { SpendGuard, type SpendGuardOptions } from "./guard.js";
import { BytePayer } from "./payer.js";

/** Header a Byte-aware server sends its requirements in. */
export const BYTE_REQUIREMENTS_HEADER = "payment-required";

/** Header the client returns its payment payload in. */
export const BYTE_PAYMENT_HEADER = "payment-signature";

export interface ByteFetchOptions {
  wallet: SpendingWallet;
  /** Spend guard, or options to build one. Omit for no guard — see the warning below. */
  guard?: SpendGuard | SpendGuardOptions;
  /**
   * How many times to settle and retry for a single request. Defaults to 1.
   *
   * Above 1, a server that keeps answering 402 can charge repeatedly for one call. The
   * default exists so that a misbehaving or broken server costs at most one payment.
   */
  maxPayments?: number;
  /** Underlying fetch. Defaults to the global. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export type ByteFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function decodeRequirements(response: Response): unknown {
  const header = response.headers.get(BYTE_REQUIREMENTS_HEADER);
  if (header !== null) {
    let json: string;
    try {
      json = Buffer.from(header, "base64").toString("utf8");
    } catch (cause) {
      throw new ByteProtocolError(
        `${BYTE_REQUIREMENTS_HEADER} header is not valid base64`,
        { cause },
      );
    }
    try {
      return JSON.parse(json);
    } catch (cause) {
      throw new ByteProtocolError(
        `${BYTE_REQUIREMENTS_HEADER} header is not valid JSON`,
        { cause },
      );
    }
  }
  return undefined;
}

async function requirementsFrom(response: Response): Promise<unknown> {
  const fromHeader = decodeRequirements(response);
  if (fromHeader !== undefined) return fromHeader;

  // Fall back to the body. Servers that find base64 headers awkward may send the
  // requirements as JSON instead, and both are unambiguous.
  const clone = response.clone();
  try {
    const body = (await clone.json()) as { accepts?: unknown[] } | unknown;
    if (
      typeof body === "object" &&
      body !== null &&
      "accepts" in body &&
      Array.isArray((body as { accepts: unknown[] }).accepts)
    ) {
      return (body as { accepts: unknown[] }).accepts[0];
    }
    return body;
  } catch (cause) {
    throw new ByteProtocolError(
      "server replied 402 but carried no Byte payment requirements",
      { cause },
    );
  }
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Build a paying fetch.
 *
 * **With no guard, this will pay whatever it is asked, to whoever asks.** That is
 * occasionally what you want in a test, and essentially never what you want in an agent
 * holding real funds.
 */
export function createByteFetch(options: ByteFetchOptions): ByteFetch {
  const guard =
    options.guard === undefined
      ? undefined
      : options.guard instanceof SpendGuard
        ? options.guard
        : new SpendGuard(options.guard);

  const payer = new BytePayer({
    wallet: options.wallet,
    ...(guard !== undefined ? { guard } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  const doFetch = options.fetch ?? globalThis.fetch;
  const maxPayments = options.maxPayments ?? 1;
  if (!Number.isInteger(maxPayments) || maxPayments < 1) {
    throw new ByteProtocolError("maxPayments must be a positive integer");
  }

  return async function byteFetch(input, init) {
    const url = urlOf(input);
    let response = await doFetch(input, init);

    for (let paid = 0; response.status === 402 && paid < maxPayments; paid++) {
      const requirements = await requirementsFrom(response);
      const { payload } = await payer.pay(requirements, url);

      const headers = new Headers(init?.headers);
      headers.set(
        BYTE_PAYMENT_HEADER,
        Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      );

      response = await doFetch(input, { ...init, headers });
    }

    return response;
  };
}

/** Encode requirements for the response header. Used by servers and tests. */
export function encodeRequirementsHeader(requirements: BytePaymentRequirements): string {
  return Buffer.from(JSON.stringify(requirements), "utf8").toString("base64");
}

/** Decode a payment payload from a request header. Used by servers. */
export function decodePaymentHeader(header: string | null): unknown {
  if (header === null) return undefined;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch (cause) {
    throw new ByteProtocolError(`${BYTE_PAYMENT_HEADER} header is malformed`, { cause });
  }
}
