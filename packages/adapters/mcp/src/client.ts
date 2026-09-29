/**
 * The MCP client half.
 *
 * Wraps a tool-calling function so that a payment-required result is settled and the call
 * retried. An agent swaps its `callTool` for this and paid tools start working.
 */

import { ByteProtocolError } from "@byte-protocol/core";
import { BytePayer, SpendGuard, type SpendGuardOptions } from "@byte-protocol/client";
import type { SpendingWallet } from "@byte-protocol/wallet";
import {
  paymentMeta,
  paymentRequirementsFrom,
  type McpToolRequest,
  type McpToolResult,
} from "./gate.js";

export type ToolCaller = (request: McpToolRequest) => Promise<McpToolResult>;

export interface PayingToolCallerOptions {
  wallet: SpendingWallet;
  guard?: SpendGuard | SpendGuardOptions;
  /**
   * Identifies the server for the guard's allowlist and audit log.
   *
   * MCP has no URL at the tool-call layer, so one is supplied here. Without it a guard's
   * host allowlist has nothing to match against, and an agent connected to several MCP
   * servers could not distinguish them in its audit log.
   */
  serverUrl: string;
  /** Payments per call. Defaults to 1, so a server that keeps demanding payment costs one. */
  maxPayments?: number;
  now?: () => number;
}

/**
 * Wrap a tool caller so it settles Byte payments.
 *
 * A result that is an error but carries no Byte requirements is passed straight through —
 * a tool that genuinely failed is not a tool asking to be paid.
 */
export function createPayingToolCaller(
  call: ToolCaller,
  options: PayingToolCallerOptions,
): ToolCaller {
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

  const maxPayments = options.maxPayments ?? 1;
  if (!Number.isInteger(maxPayments) || maxPayments < 1) {
    throw new ByteProtocolError("maxPayments must be a positive integer");
  }

  return async function payingCall(request: McpToolRequest): Promise<McpToolResult> {
    let result = await call(request);

    for (let paid = 0; paid < maxPayments; paid++) {
      const requirements = paymentRequirementsFrom(result);
      if (requirements === undefined) return result;

      const { payload } = await payer.pay(requirements, options.serverUrl);

      result = await call({
        ...request,
        params: {
          ...request.params,
          _meta: {
            ...request.params._meta,
            ...paymentMeta({ invoiceId: payload.invoiceId, txid: payload.txid }),
          },
        },
      });
    }

    return result;
  };
}
