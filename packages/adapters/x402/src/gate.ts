/**
 * Server and client halves of the x402 adapter.
 *
 * Both are framework-free: the server half is a function from a request shape to a
 * response shape, and the client half wraps `fetch`. Anything that can produce those two
 * shapes can use Byte over x402.
 */

import { ByteProtocolError } from "@byte-protocol/core";
import type { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import { BytePayer, SpendGuard, type SpendGuardOptions } from "@byte-protocol/client";
import type { SpendingWallet } from "@byte-protocol/wallet";
import {
  EXTENSION_RESPONSES_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  decodeHeader,
  encodeHeader,
  fromX402Payload,
  fromX402Requirements,
  toX402PaymentRequired,
  toX402Payload,
  type X402PaymentRequired,
  type X402SettlementResponse,
} from "./mapping.js";

export interface GateRequest {
  header: (name: string) => string | null | undefined;
}

export interface GateResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface X402GateOptions {
  issuer: InvoiceIssuer;
  verifier: PaymentVerifier;
  /** Price in zatoshis. */
  priceZat: string;
  now?: () => number;
}

/**
 * Guard a resource behind an x402-shaped Byte payment.
 *
 * Returns `{ paid: true }` when the caller may be served, or a ready-made 402/409 response
 * when they may not. The caller serves the resource itself — the gate never touches it, so
 * it cannot leak one by accident.
 */
export function createX402Gate(options: X402GateOptions) {
  const now = options.now ?? Date.now;

  return async function gate(
    request: GateRequest,
  ): Promise<{ paid: true; txid: string } | { paid: false; response: GateResponse }> {
    const header = request.header(PAYMENT_SIGNATURE_HEADER);

    const require402 = async (error?: string): Promise<GateResponse> => {
      const invoice = await options.issuer.issue(options.priceZat);
      const body: X402PaymentRequired = toX402PaymentRequired(invoice, {
        now: now(),
        ...(error !== undefined ? { error } : {}),
      });
      return {
        status: 402,
        headers: {
          "content-type": "application/json",
          [PAYMENT_REQUIRED_HEADER]: encodeHeader(body),
        },
        body,
      };
    };

    if (header === null || header === undefined || header === "") {
      return {
        paid: false,
        response: await require402(`${PAYMENT_SIGNATURE_HEADER} header is required`),
      };
    }

    let claim: { invoiceId: string; txid: string };
    try {
      claim = fromX402Payload(decodeHeader(header));
    } catch (error) {
      return {
        paid: false,
        response: await require402(error instanceof Error ? error.message : "malformed payload"),
      };
    }

    const result = await options.verifier.verify(claim.invoiceId, claim.txid);

    if (result.ok) {
      return { paid: true, txid: result.txid };
    }

    if (result.reason === "replay") {
      const settlement: X402SettlementResponse = {
        success: false,
        transaction: claim.txid,
        network: options.issuer.network,
        errorReason: "replay",
      };
      return {
        paid: false,
        response: {
          status: 409,
          headers: {
            "content-type": "application/json",
            [EXTENSION_RESPONSES_HEADER]: encodeHeader({ byte: settlement }),
          },
          body: { success: false, reason: result.reason, message: result.message },
        },
      };
    }

    const response = await require402(result.message);
    return {
      paid: false,
      response: {
        ...response,
        body: {
          ...(response.body as object),
          reason: result.reason,
          ...(result.shortfallZat !== undefined ? { shortfallZat: result.shortfallZat } : {}),
          ...(result.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: result.retryAfterSeconds }
            : {}),
        },
      },
    };
  };
}

/** Build the x402 settlement response for a successful payment. */
export function settlementOf(
  txid: string,
  network: X402SettlementResponse["network"],
  amountZat: string,
): X402SettlementResponse {
  return { success: true, transaction: txid, network, amount: amountZat };
}

export interface X402FetchOptions {
  wallet: SpendingWallet;
  guard?: SpendGuard | SpendGuardOptions;
  fetch?: typeof globalThis.fetch;
  /** Payments per request. Defaults to 1, so a 402-looping server costs one payment. */
  maxPayments?: number;
  now?: () => number;
}

/**
 * A `fetch` that settles x402 402s with Byte.
 *
 * Distinct from `@byte-protocol/client`'s `createByteFetch` only in wire format: this one
 * reads and writes x402 v2 envelopes.
 */
export function createX402Fetch(options: X402FetchOptions) {
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
  const now = options.now ?? Date.now;

  return async function x402Fetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    let response = await doFetch(input, init);

    for (let paid = 0; response.status === 402 && paid < maxPayments; paid++) {
      const required = (decodeHeader(response.headers.get(PAYMENT_REQUIRED_HEADER)) ??
        (await response.clone().json())) as X402PaymentRequired | undefined;

      const accepted = required?.accepts?.[0];
      if (accepted === undefined) {
        throw new ByteProtocolError("402 carried no x402 payment requirements");
      }

      const invoice = fromX402Requirements(accepted, now());
      const { payload } = await payer.pay(invoice, url);

      const headers = new Headers(init?.headers);
      headers.set(PAYMENT_SIGNATURE_HEADER, encodeHeader(toX402Payload(accepted, payload)));
      response = await doFetch(input, { ...init, headers });
    }

    return response;
  };
}
