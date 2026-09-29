/**
 * The owner-only JSON API.
 *
 * Everything an operator needs to see about their own Byte node: what has been invoiced,
 * what has been paid, what can be spent, and what the spend guard has allowed or refused.
 *
 * ## Owner-only means owner-only
 *
 * This API reports invoice amounts, transaction identifiers, addresses and balances. That is
 * precisely the information Byte keeps off the chain. Exposing it publicly would undo the
 * protocol's entire purpose more thoroughly than any on-chain leak, because it would be
 * *organised*.
 *
 * So: every route requires a bearer token compared in constant time, and the handler is
 * framework-free so it can be mounted behind whatever else an operator already trusts.
 * There is no unauthenticated route, not even a health check.
 */

import { timingSafeEqual, type InvoiceStore, type ReceiptStore } from "@byte-protocol/core";
import type { SpendGuard } from "@byte-protocol/client";
import type { ViewOnlyWallet } from "@byte-protocol/wallet";

export interface ConsoleRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  query?: Record<string, string | undefined>;
  header: (name: string) => string | null | undefined;
}

export interface ConsoleResponse {
  status: number;
  body: unknown;
}

export interface ConsoleApiOptions {
  wallet: ViewOnlyWallet;
  invoices: InvoiceStore;
  receipts?: ReceiptStore;
  guard?: SpendGuard;
  /** Bearer token. At least 32 characters. */
  token: string;
  /** Node name shown in the console header. */
  label?: string;
}

/** Header carrying the owner token. */
export const OWNER_TOKEN_HEADER = "authorization";

function clampLimit(raw: string | undefined, fallback = 50): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 200);
}

export function createConsoleApi(options: ConsoleApiOptions) {
  if (options.token.length < 32) {
    throw new Error("console token must be at least 32 characters");
  }

  const authorized = (request: ConsoleRequest): boolean => {
    const raw = request.header(OWNER_TOKEN_HEADER) ?? "";
    const presented = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
    return timingSafeEqual(presented, options.token);
  };

  return async function handle(request: ConsoleRequest): Promise<ConsoleResponse> {
    if (!authorized(request)) {
      // No route is exempt. A health check that reports whether a node exists is still
      // information about that node.
      return { status: 401, body: { error: "unauthorized" } };
    }

    const path = request.path.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && (path === "/" || path === "/overview")) {
      const [status, balance] = await Promise.all([
        options.wallet.status(),
        options.wallet.balance().catch(() => undefined),
      ]);
      const { invoices } = await options.invoices.list({ limit: 200 });
      const now = Date.now();

      return {
        status: 200,
        body: {
          label: options.label ?? "byte node",
          network: options.wallet.network,
          sync: status,
          // Undefined rather than zeroes when the wallet cannot report. A zero balance from
          // an unsynced wallet is indistinguishable from an empty one.
          balance: balance ?? null,
          invoices: {
            total: invoices.length,
            consumed: invoices.filter((i) => i.consumedAt !== undefined).length,
            outstanding: invoices.filter((i) => i.consumedAt === undefined && now < i.expiresAt)
              .length,
            expired: invoices.filter((i) => i.consumedAt === undefined && now >= i.expiresAt)
              .length,
          },
          settledZat: invoices
            .filter((i) => i.consumedAt !== undefined)
            .reduce((sum, i) => sum + BigInt(i.amountZat), 0n)
            .toString(10),
          guard:
            options.guard === undefined
              ? null
              : {
                  spentTodayZat: options.guard.spentTodayZat(),
                  decisions: options.guard.auditLog().length,
                  refusals: options.guard.auditLog().filter((e) => !e.allowed).length,
                },
        },
      };
    }

    if (request.method === "GET" && path === "/invoices") {
      const statusFilter = request.query?.status;
      const result = await options.invoices.list({
        limit: clampLimit(request.query?.limit),
        ...(request.query?.cursor !== undefined ? { cursor: request.query.cursor } : {}),
        ...(statusFilter === "outstanding" ||
        statusFilter === "consumed" ||
        statusFilter === "expired"
          ? { status: statusFilter }
          : {}),
      });
      return { status: 200, body: result };
    }

    if (request.method === "GET" && path.startsWith("/invoices/")) {
      const id = path.slice("/invoices/".length);
      const invoice = await options.invoices.get(id);
      return invoice === undefined
        ? { status: 404, body: { error: "not_found" } }
        : { status: 200, body: invoice };
    }

    if (request.method === "GET" && path === "/receipts") {
      if (options.receipts === undefined) {
        return { status: 404, body: { error: "receipts_not_configured" } };
      }
      return {
        status: 200,
        body: await options.receipts.list({ limit: clampLimit(request.query?.limit) }),
      };
    }

    if (request.method === "GET" && path === "/balance") {
      try {
        return { status: 200, body: await options.wallet.balance() };
      } catch (error) {
        // Surfaced rather than flattened to zeroes: "I do not know" is a different answer
        // from "you have nothing".
        return {
          status: 503,
          body: {
            error: "unavailable",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    if (request.method === "GET" && path === "/guard") {
      if (options.guard === undefined) {
        return { status: 404, body: { error: "guard_not_configured" } };
      }
      const limit = clampLimit(request.query?.limit, 100);
      const log = options.guard.auditLog();
      return {
        status: 200,
        body: {
          spentTodayZat: options.guard.spentTodayZat(),
          entries: log.slice(-limit).reverse(),
        },
      };
    }

    return { status: 404, body: { error: "not_found" } };
  };
}
