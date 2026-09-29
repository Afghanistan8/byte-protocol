/**
 * Byte as LangChain tools.
 *
 * Gives an agent three things it can do with money: fetch something that costs money,
 * check what it can spend, and look at what it has already spent.
 *
 * ## Why these are tool *definitions* rather than LangChain classes
 *
 * Each factory returns `{ name, description, schema, func }` — exactly the arguments
 * `DynamicStructuredTool` takes — without importing LangChain. A payment adapter should not
 * pin the LangChain version of every agent that wants to spend, and LangChain's package
 * layout has moved more than once. Wiring is one line:
 *
 * ```ts
 * import { DynamicStructuredTool } from "@langchain/core/tools";
 * const tools = createByteTools({ wallet }).map((t) => new DynamicStructuredTool(t));
 * ```
 *
 * ## Why the descriptions are blunt about cost
 *
 * The description is the only thing a model reads before deciding to call a tool. A tool
 * that spends money and does not say so in its description is a tool a model will call
 * casually.
 */

import { z } from "zod";
import { formatZat, parseZat } from "@byte-protocol/core";
import { SpendGuard, createByteFetch, type SpendGuardOptions } from "@byte-protocol/client";
import type { SpendingWallet } from "@byte-protocol/wallet";

/** The shape LangChain's `DynamicStructuredTool` takes. */
export interface ByteToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: TSchema;
  func: (input: z.infer<TSchema>) => Promise<string>;
}

export interface ByteToolsOptions {
  wallet: SpendingWallet;
  guard?: SpendGuard | SpendGuardOptions;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

const fetchPaidSchema = z.object({
  url: z.string().describe("The full URL of the paid resource to fetch."),
  method: z
    .enum(["GET", "POST"])
    .default("GET")
    .describe("HTTP method. Defaults to GET."),
  body: z
    .string()
    .optional()
    .describe("Optional request body, used only with POST."),
});

const emptySchema = z.object({});

function resolveGuard(guard: ByteToolsOptions["guard"]): SpendGuard | undefined {
  if (guard === undefined) return undefined;
  return guard instanceof SpendGuard ? guard : new SpendGuard(guard);
}

/**
 * Fetch a resource, paying for it if it asks to be paid.
 *
 * Returns the response body as text. A payment refused by the guard is returned as a
 * message rather than thrown: a tool that throws tends to end an agent's run, and "I was not
 * allowed to spend that much" is information the model should be able to act on — by asking
 * a human, or by choosing a cheaper route.
 */
export function createFetchPaidTool(
  options: ByteToolsOptions,
): ByteToolDefinition<typeof fetchPaidSchema> {
  const guard = resolveGuard(options.guard);
  const pay = createByteFetch({
    wallet: options.wallet,
    ...(guard !== undefined ? { guard } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  return {
    name: "byte_fetch_paid",
    description:
      "Fetch a web resource that may require payment, paying for it automatically in " +
      "shielded Zcash if it does. THIS SPENDS REAL MONEY from the agent's wallet. Use it " +
      "only when the user has asked for something behind a paywall, and check byte_balance " +
      "first if you are unsure funds are available.",
    schema: fetchPaidSchema,
    func: async ({ url, method, body }) => {
      try {
        const response = await pay(url, {
          method,
          ...(body !== undefined && method === "POST" ? { body } : {}),
        });
        const text = await response.text();

        if (!response.ok) {
          return `The request failed with HTTP ${response.status}. Body: ${text.slice(0, 2000)}`;
        }
        return text.slice(0, 20_000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `The payment did not happen: ${message}`;
      }
    },
  };
}

/**
 * Report what the wallet can spend.
 *
 * Reports spendable, pending and unusable separately. Collapsing them into one number would
 * tell a model it has funds it cannot actually send — value sitting outside Ironwood is real
 * but unspendable by Byte, and value below the confirmation threshold is not there yet.
 */
export function createBalanceTool(
  options: ByteToolsOptions,
): ByteToolDefinition<typeof emptySchema> {
  return {
    name: "byte_balance",
    description:
      "Check the agent's shielded Zcash balance before spending. Returns spendable, " +
      "pending and unusable amounts in zatoshis. Only the spendable amount can be paid out.",
    schema: emptySchema,
    func: async () => {
      const balance = await options.wallet.balance();
      const status = await options.wallet.status();

      const lines = [
        `Spendable: ${balance.spendableZat} zatoshis`,
        `Pending (not yet confirmed): ${balance.pendingZat} zatoshis`,
        `Unusable (outside the Ironwood pool, cannot be spent by Byte): ${balance.unusableZat} zatoshis`,
        `Network: ${options.wallet.network}`,
        status.synced
          ? `Wallet is synced to block ${status.syncedHeight}.`
          : `WARNING: the wallet is not synced (at block ${status.syncedHeight}), so these figures may be out of date.`,
      ];
      return lines.join("\n");
    },
  };
}

/**
 * Report what has been spent, and what was refused.
 *
 * Refusals are included deliberately. An agent that can see it was denied can explain that
 * to a user; one that only sees successes will keep retrying the same denied call.
 */
export function createSpendReportTool(
  guard: SpendGuard,
): ByteToolDefinition<typeof emptySchema> {
  return {
    name: "byte_spend_report",
    description:
      "Review the agent's recent payments and any payments that were refused by its " +
      "spending limits. Use this to explain spending to a user, or to understand why a " +
      "payment was not allowed.",
    schema: emptySchema,
    func: async () => {
      const log = guard.auditLog();
      if (log.length === 0) return "No payments have been attempted.";

      const recent = log.slice(-20).map((entry) => {
        const when = new Date(entry.at).toISOString();
        return entry.allowed
          ? `${when}  PAID     ${entry.amountZat} zat to ${entry.host}`
          : `${when}  REFUSED  ${entry.amountZat} zat to ${entry.host} (${entry.reason})`;
      });

      return [
        `Spent in the last 24 hours: ${guard.spentTodayZat()} zatoshis`,
        `Attempts recorded: ${log.length}`,
        "",
        ...recent,
      ].join("\n");
    },
  };
}

/**
 * All Byte tools for an agent.
 *
 * `byte_spend_report` is included only when a guard exists, because without one there are no
 * limits to report and no refusals to explain.
 */
export function createByteTools(options: ByteToolsOptions): ByteToolDefinition[] {
  const guard = resolveGuard(options.guard);
  const withGuard = { ...options, ...(guard !== undefined ? { guard } : {}) };

  const tools: ByteToolDefinition[] = [
    createFetchPaidTool(withGuard) as ByteToolDefinition,
    createBalanceTool(withGuard) as ByteToolDefinition,
  ];
  if (guard !== undefined) {
    tools.push(createSpendReportTool(guard) as ByteToolDefinition);
  }
  return tools;
}

/** Format zatoshis for a human-facing message. Exported for examples. */
export function describeAmount(amountZat: string): string {
  const zat = parseZat(amountZat);
  return `${formatZat(zat)} zatoshis`;
}
