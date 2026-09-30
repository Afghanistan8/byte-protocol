/**
 * Treasury tools: receipts, shielding, cash-out and the agent card.
 *
 * ## Deliberately separate from `createByteTools`
 *
 * `createByteTools` lets an agent *pay for things*, under a spend guard. These let it move
 * value across the transparent boundary, which **publishes an amount on a public chain**.
 * An operator who handed an agent a paywall-fetching tool did not thereby agree to let it
 * unshield, so this is a different factory that has to be called on purpose.
 *
 * ## What each tool refuses to do on its own
 *
 * - `byte_unshield` and `byte_cashout` do nothing unless `confirm` is true, and say what
 *   would happen when it is not. A model exploring what a tool does should not move money.
 * - Both go through the spend guard when one is configured, so the same caps apply.
 * - `byte_cashout` will not send to a quote whose 1Click signature did not verify.
 */

import { z } from "zod";
import type { ReceiptStore } from "@byte-protocol/core";
import type { SpendGuard } from "@byte-protocol/client";
import type { ShieldingWallet } from "@byte-protocol/wallet";
import type { ByteToolDefinition } from "./tools.js";

/** The slice of a cash-out rail these tools use. Structural, so no package dependency. */
export interface CashOutRailLike {
  cashOutQuote(request: {
    to: string;
    amountInZat: string;
    recipient: string;
    dry?: boolean;
  }): Promise<{
    dry: boolean;
    depositAddress?: string;
    amountIn: string;
    amountOutZat: string;
    signatureVerified: boolean;
    fees?: { items: unknown[]; unrequested: unknown[]; note?: string };
  }>;
  payCashOut(quote: never): Promise<{ txid: string; feeZat: string }>;
}

export interface TreasuryToolsOptions {
  wallet: ShieldingWallet;
  guard?: SpendGuard;
  receipts?: ReceiptStore;
  rail?: CashOutRailLike;
  /** The agent's own signed card, if it has one. */
  agentCard?: unknown;
}

const empty = z.object({});

export function createReceiptTool(store: ReceiptStore): ByteToolDefinition<z.ZodObject<{ invoiceId: z.ZodString }>> {
  return {
    name: "byte_receipt",
    description:
      "Look up the signed receipt for a payment this agent received, by invoice ID. A " +
      "receipt proves one payment and discloses nothing about any other.",
    schema: z.object({ invoiceId: z.string().describe("The 32-character invoice ID.") }),
    func: async ({ invoiceId }) => {
      const receipt = await store.get(invoiceId);
      return receipt === undefined
        ? `No receipt found for invoice ${invoiceId}.`
        : JSON.stringify(receipt, null, 2);
    },
  };
}

export function createShieldTool(wallet: ShieldingWallet): ByteToolDefinition<typeof empty> {
  return {
    name: "byte_shield",
    description:
      "Move transparent ZEC into the shielded Ironwood pool so it can be spent privately. " +
      "The transparent deposit was already public; shielding ends further exposure but does " +
      "not undo it. Costs a network fee.",
    schema: empty,
    func: async () => {
      const result = await wallet.shield();
      return result.transactions.length === 0
        ? "Nothing to shield: no transparent balance above the threshold."
        : `Shielded ${result.shieldedZat} zatoshis in ${result.transactions.length} transaction(s). Fees: ${result.feeZat} zatoshis.`;
    },
  };
}

const unshieldSchema = z.object({
  toTransparent: z.string().describe("A transparent Zcash address (t1 or t3)."),
  amountZat: z.string().describe("Zatoshis, as an integer string."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Must be true to actually send. Without it, this only describes the effect."),
});

export function createUnshieldTool(
  wallet: ShieldingWallet,
  guard?: SpendGuard,
): ByteToolDefinition<typeof unshieldSchema> {
  return {
    name: "byte_unshield",
    description:
      "Send shielded ZEC out to a TRANSPARENT address. THIS PUBLISHES THE AMOUNT on the " +
      "public chain and moves real money. Only use it when the user asked for it. Set " +
      "confirm to true to send; without it nothing happens.",
    schema: unshieldSchema,
    func: async ({ toTransparent, amountZat, confirm }) => {
      if (!confirm) {
        return (
          `Would send ${amountZat} zatoshis to ${toTransparent}. The amount and the ` +
          "destination would be public. Nothing was sent; call again with confirm: true."
        );
      }
      if (guard !== undefined) {
        const decision = await guard.authorize({ amountZat, url: "byte:unshield" });
        if (!decision.allowed) return `Refused by the spend guard: ${decision.message}`;
      }
      try {
        const result = await wallet.unshield({ toTransparent, amountZat });
        return `Sent. txid ${result.txid}. ${result.publicAmountZat} zatoshis are now public. Fee ${result.feeZat}.`;
      } catch (error) {
        guard?.refund(amountZat);
        return `Not sent: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

const cashOutSchema = z.object({
  to: z.string().describe("Destination asset id, e.g. a USDC asset id."),
  amountZat: z.string().describe("Zatoshis of ZEC to send, as an integer string."),
  recipient: z.string().describe("The address on the destination chain."),
  confirm: z.boolean().default(false).describe("Must be true to actually send."),
});

export function createCashOutTool(
  rail: CashOutRailLike,
  guard?: SpendGuard,
): ByteToolDefinition<typeof cashOutSchema> {
  return {
    name: "byte_cashout",
    description:
      "Swap shielded ZEC for another asset through NEAR Intents. THIS PUBLISHES THE AMOUNT " +
      "(ZEC leaves the shielded pool to a public address) and moves real money. Without " +
      "confirm it returns a dry quote only.",
    schema: cashOutSchema,
    func: async ({ to, amountZat, recipient, confirm }) => {
      const quote = await rail.cashOutQuote({
        to,
        amountInZat: amountZat,
        recipient,
        dry: !confirm,
      });
      const summary =
        `Send ${quote.amountIn} zatoshis, receive about ${quote.amountOutZat} ` +
        `(signature verified: ${quote.signatureVerified}). ${quote.fees?.note ?? ""}`.trim();

      if (!confirm) return `DRY QUOTE, nothing sent. ${summary}`;

      if (guard !== undefined) {
        const decision = await guard.authorize({ amountZat: quote.amountIn, url: "byte:cashout" });
        if (!decision.allowed) return `Refused by the spend guard: ${decision.message}`;
      }
      try {
        const sent = await rail.payCashOut(quote as never);
        return `Sent. txid ${sent.txid}. ${summary}`;
      } catch (error) {
        guard?.refund(quote.amountIn);
        return `Not sent: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

export function createAgentCardTool(card: unknown): ByteToolDefinition<typeof empty> {
  return {
    name: "byte_agent_card",
    description:
      "Return this agent's signed Byte Agent Card: its ID, endpoint, payment address and " +
      "accepted schemes. Share it so others can pay this agent.",
    schema: empty,
    func: async () => JSON.stringify(card, null, 2),
  };
}

/**
 * Treasury tools, opt-in.
 *
 * Only builds a tool when what it needs was supplied, so an agent is never offered a tool
 * that would fail: a receipt tool with no store, or a cash-out with no rail, is absent
 * rather than present and broken.
 */
export function createTreasuryTools(options: TreasuryToolsOptions): ByteToolDefinition[] {
  const tools: ByteToolDefinition[] = [
    createShieldTool(options.wallet) as ByteToolDefinition,
    createUnshieldTool(options.wallet, options.guard) as ByteToolDefinition,
  ];
  if (options.receipts !== undefined) tools.push(createReceiptTool(options.receipts) as ByteToolDefinition);
  if (options.rail !== undefined) tools.push(createCashOutTool(options.rail, options.guard) as ByteToolDefinition);
  if (options.agentCard !== undefined) tools.push(createAgentCardTool(options.agentCard) as ByteToolDefinition);
  return tools;
}

