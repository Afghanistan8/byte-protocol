/**
 * A framework-free HTTP handler for the facilitator.
 *
 * Returns a plain request handler so this can be mounted on Node's `http`, Express, Hono,
 * or anything else, without the package depending on a web framework.
 *
 *   GET  /info      what this facilitator is and what it accepts
 *   GET  /health    whether it is synced enough to verify anything
 *   POST /invoices  mint an invoice
 *   POST /verify    check a payment claim
 *
 * Everything but `/health` requires the API key.
 */

import type { ByteFacilitator } from "./facilitator.js";

export interface FacilitatorRequest {
  method: string;
  /** Path only, without query string. */
  path: string;
  /** Header lookup, case-insensitive on the caller's side. */
  header: (name: string) => string | null | undefined;
  /** Parsed JSON body, or undefined. */
  body?: unknown;
}

export interface FacilitatorResponse {
  status: number;
  body: unknown;
}

/** Header carrying the facilitator API key. */
export const API_KEY_HEADER = "x-byte-api-key";

export function createFacilitatorHandler(facilitator: ByteFacilitator) {
  return async function handle(request: FacilitatorRequest): Promise<FacilitatorResponse> {
    const path = request.path.replace(/\/+$/, "") || "/";

    // Unauthenticated, so a supervisor can check liveness without holding the key. It
    // reports only sync state, which is not sensitive.
    if (request.method === "GET" && path === "/health") {
      const health = await facilitator.health();
      return { status: health.ok ? 200 : 503, body: health };
    }

    if (!facilitator.authorize(request.header(API_KEY_HEADER))) {
      return {
        status: 401,
        body: { error: "unauthorized", message: `missing or invalid ${API_KEY_HEADER}` },
      };
    }

    if (request.method === "GET" && path === "/info") {
      return { status: 200, body: facilitator.info() };
    }

    if (request.method === "POST" && path === "/invoices") {
      const body = request.body as { amountZat?: unknown } | undefined;
      if (typeof body?.amountZat !== "string") {
        return {
          status: 400,
          body: { error: "bad_request", message: "amountZat must be a string of zatoshis" },
        };
      }
      try {
        return { status: 200, body: await facilitator.issue(body.amountZat) };
      } catch (error) {
        return {
          status: 400,
          body: {
            error: "bad_request",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    if (request.method === "POST" && path === "/verify") {
      const body = request.body as { invoiceId?: unknown; txid?: unknown } | undefined;
      if (typeof body?.invoiceId !== "string" || typeof body.txid !== "string") {
        return {
          status: 400,
          body: { error: "bad_request", message: "invoiceId and txid are required" },
        };
      }

      const result = await facilitator.verify({ invoiceId: body.invoiceId, txid: body.txid });
      if (result.ok) {
        return {
          status: 200,
          body: {
            ok: true,
            invoiceId: result.invoice.invoiceId,
            txid: result.txid,
            amountZat: result.invoice.amountZat,
            pool: result.note.pool,
            confirmations: result.note.confirmations,
          },
        };
      }

      // A replay is a conflict, not a payment-required. Everything else keeps the 402
      // shape the client loop expects, and the reason strings match SPEC section 8.
      return {
        status: result.reason === "replay" ? 409 : 402,
        body: {
          ok: false,
          reason: result.reason,
          message: result.message,
          ...(result.shortfallZat !== undefined ? { shortfallZat: result.shortfallZat } : {}),
          ...(result.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: result.retryAfterSeconds }
            : {}),
        },
      };
    }

    return { status: 404, body: { error: "not_found" } };
  };
}
