/**
 * Byte payments for MCP tools.
 *
 * An MCP server exposes tools; some of them cost money to run. This wraps a tool handler so
 * that calling it without payment returns payment requirements, and calling it with a valid
 * payment runs the real handler.
 *
 * ## Why there is no MCP SDK dependency
 *
 * The types below are structural, matching the shapes `@modelcontextprotocol/sdk` uses
 * without importing it. A payment adapter should not pin the SDK version of every server
 * that wants to charge for a tool, and the shapes it needs — a result with `content` and
 * `isError`, and a request with `_meta` — are stable parts of the protocol rather than
 * implementation details.
 *
 * ## Where the payment rides
 *
 * In `_meta`, MCP's designated extension point, under keys namespaced with `byte/`. Tool
 * arguments belong to the tool's own input schema; putting a payment there would mean every
 * paid tool had to declare a payment field it does not care about, and clients validating
 * against the schema would reject it.
 */

import { ByteProtocolError } from "@byte-protocol/core";
import type { BytePaymentRequirements } from "@byte-protocol/core";
import type { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";

/** `_meta` key carrying payment requirements on an unpaid result. */
export const PAYMENT_REQUIRED_META = "byte/payment-required";

/** `_meta` key carrying the client's payment claim on a request. */
export const PAYMENT_META = "byte/payment";

/** Minimal structural shape of an MCP tool result. */
export interface McpToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Minimal structural shape of an MCP tool-call request. */
export interface McpToolRequest {
  params: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
}

export type McpToolHandler = (request: McpToolRequest) => Promise<McpToolResult>;

/** A payment claim as it travels in `_meta`. */
export interface McpPaymentClaim {
  invoiceId: string;
  txid: string;
}

export interface GateToolOptions {
  issuer: InvoiceIssuer;
  verifier: PaymentVerifier;
  /** Price in zatoshis. */
  priceZat: string;
  /** Shown to the model in the unpaid result, so it can explain the cost to a user. */
  description?: string;
}

function claimFrom(meta: Record<string, unknown> | undefined): McpPaymentClaim | undefined {
  const raw = meta?.[PAYMENT_META];
  if (typeof raw !== "object" || raw === null) return undefined;
  const claim = raw as Partial<McpPaymentClaim>;
  if (typeof claim.invoiceId !== "string" || typeof claim.txid !== "string") return undefined;
  return { invoiceId: claim.invoiceId, txid: claim.txid };
}

function paymentRequiredResult(
  invoice: BytePaymentRequirements,
  message: string,
  extra: Record<string, unknown> = {},
): McpToolResult {
  return {
    // `isError` is what makes an MCP client surface this to the model rather than treating
    // it as a successful tool result. An unpaid call has not done the work, so it is an
    // error even though it is an expected one.
    isError: true,
    content: [{ type: "text", text: message }],
    _meta: {
      [PAYMENT_REQUIRED_META]: { ...invoice, ...extra },
    },
  };
}

/**
 * Wrap a tool handler so it requires a Byte payment.
 *
 * The real handler runs only after the invoice has been consumed. A handler that throws
 * does not un-consume the invoice — the payment was made and the invoice really is spent —
 * which is the honest behaviour even though it is the unkind one. A tool that can fail
 * expensively should be idempotent and re-runnable by its caller.
 */
export function gateTool(handler: McpToolHandler, options: GateToolOptions): McpToolHandler {
  return async function gated(request: McpToolRequest): Promise<McpToolResult> {
    const claim = claimFrom(request.params._meta);

    if (claim === undefined) {
      const invoice = await options.issuer.issue(options.priceZat);
      return paymentRequiredResult(
        invoice,
        options.description ??
          `This tool costs ${options.priceZat} zatoshis. Pay the invoice in _meta["${PAYMENT_REQUIRED_META}"] and call again with the payment in _meta["${PAYMENT_META}"].`,
      );
    }

    const result = await options.verifier.verify(claim.invoiceId, claim.txid);

    if (!result.ok) {
      if (result.reason === "replay") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "That payment has already been used. Each invoice pays for one call.",
            },
          ],
          _meta: { "byte/reason": "replay" },
        };
      }

      const invoice = await options.issuer.issue(options.priceZat);
      return paymentRequiredResult(invoice, result.message, {
        reason: result.reason,
        ...(result.shortfallZat !== undefined ? { shortfallZat: result.shortfallZat } : {}),
        ...(result.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: result.retryAfterSeconds }
          : {}),
      });
    }

    const served = await handler(request);
    return {
      ...served,
      _meta: { ...served._meta, "byte/txid": result.txid },
    };
  };
}

/**
 * Extract payment requirements from an unpaid tool result.
 *
 * Returns undefined when the result is not a Byte payment request, so a client can tell
 * "this tool wants paying" from "this tool failed".
 */
export function paymentRequirementsFrom(
  result: McpToolResult,
): BytePaymentRequirements | undefined {
  const raw = result._meta?.[PAYMENT_REQUIRED_META];
  if (typeof raw !== "object" || raw === null) return undefined;
  return raw as BytePaymentRequirements;
}

/** Build the `_meta` a client sends with a paid call. */
export function paymentMeta(claim: McpPaymentClaim): Record<string, unknown> {
  if (typeof claim.invoiceId !== "string" || typeof claim.txid !== "string") {
    throw new ByteProtocolError("a payment claim needs invoiceId and txid");
  }
  return { [PAYMENT_META]: claim };
}
