import { describe, expect, it } from "vitest";
import { NETWORK_TESTNET, newSigningKey, signReceipt } from "@byte-protocol/core";
import { MemoryReceiptStore } from "@byte-protocol/stores";
import { SpendGuard } from "@byte-protocol/client";
import { MockChain, MockWallet } from "@byte-protocol/wallet";
import { createTreasuryTools } from "./treasury.js";

const T = "t1" + "a".repeat(33);

function setup() {
  const chain = new MockChain();
  const wallet = new MockWallet({ network: NETWORK_TESTNET, chain, addressPrefix: "utest1t", sleep: async () => {} });
  chain.payInto({ payTo: wallet.fundingAddress, amountZat: "100000000" });
  chain.mine(1);
  return { chain, wallet };
}

const tool = (tools: ReturnType<typeof createTreasuryTools>, name: string) => {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
};

describe("treasury tools", () => {
  it("offers only the tools whose inputs exist", () => {
    const { wallet } = setup();
    const names = createTreasuryTools({ wallet }).map((t) => t.name);
    expect(names).toEqual(["byte_shield", "byte_unshield"]);
  });

  it("adds receipt, cash-out and card tools when their inputs are supplied", () => {
    const { wallet } = setup();
    const names = createTreasuryTools({
      wallet,
      receipts: new MemoryReceiptStore(),
      rail: { cashOutQuote: async () => ({}) as never, payCashOut: async () => ({ txid: "x", feeZat: "0" }) },
      agentCard: { agentId: "a" },
    }).map((t) => t.name);
    expect(names).toEqual(["byte_shield", "byte_unshield", "byte_receipt", "byte_cashout", "byte_agent_card"]);
  });

  it("does not unshield without confirm, and says what would happen", async () => {
    // A model exploring what a tool does must not move money.
    const { wallet, chain } = setup();
    const out = await tool(createTreasuryTools({ wallet }), "byte_unshield").func({
      toTransparent: T, amountZat: "5000000", confirm: false,
    });
    expect(out).toMatch(/Nothing was sent/);
    expect(out).toMatch(/public/);
    expect(chain.transparentAt(T)).toBe(0n);
  });

  it("unshields with confirm, and reports the amount is public", async () => {
    const { wallet, chain } = setup();
    const out = await tool(createTreasuryTools({ wallet }), "byte_unshield").func({
      toTransparent: T, amountZat: "5000000", confirm: true,
    });
    expect(out).toMatch(/now public/);
    chain.mine(1);
    expect(chain.transparentAt(T)).toBe(5000000n);
  });

  it("is stopped by the spend guard", async () => {
    const { wallet, chain } = setup();
    const guard = new SpendGuard({ maxPerCallZat: "1000" });
    const out = await tool(createTreasuryTools({ wallet, guard }), "byte_unshield").func({
      toTransparent: T, amountZat: "5000000", confirm: true,
    });
    expect(out).toMatch(/Refused by the spend guard/);
    expect(chain.transparentAt(T)).toBe(0n);
  });

  it("refunds the guard when the send fails", async () => {
    const { wallet } = setup();
    const guard = new SpendGuard({ maxDailyZat: "9000000" });
    const t = tool(createTreasuryTools({ wallet, guard }), "byte_unshield");
    await t.func({ toTransparent: "utest1notransparent", amountZat: "5000000", confirm: true });
    expect(guard.spentTodayZat()).toBe("0");
  });

  it("finds a stored receipt and reports a missing one", async () => {
    const { wallet } = setup();
    const store = new MemoryReceiptStore();
    const { secretKey } = newSigningKey();
    const r = signReceipt(secretKey, { invoiceId: "a".repeat(32), txid: "b".repeat(64), amount: "1", payTo: "u", network: NETWORK_TESTNET, timestamp: "2026-09-30T00:00:00.000Z" });
    await store.put(r);
    const t = tool(createTreasuryTools({ wallet, receipts: store }), "byte_receipt");
    expect(await t.func({ invoiceId: r.invoiceId })).toContain(r.signature);
    expect(await t.func({ invoiceId: "f".repeat(32) })).toMatch(/No receipt found/);
  });

  it("cash-out is a dry quote without confirm and never pays", async () => {
    const { wallet } = setup();
    let paid = false;
    const rail = {
      cashOutQuote: async (req: { dry?: boolean }) => ({ dry: req.dry === true, amountIn: "1", amountOutZat: "2", signatureVerified: true }),
      payCashOut: async () => { paid = true; return { txid: "x", feeZat: "0" }; },
    };
    const t = tool(createTreasuryTools({ wallet, rail: rail as never }), "byte_cashout");
    expect(await t.func({ to: "a", amountZat: "1", recipient: "r", confirm: false })).toMatch(/DRY QUOTE/);
    expect(paid).toBe(false);
    expect(await t.func({ to: "a", amountZat: "1", recipient: "r", confirm: true })).toMatch(/Sent/);
    expect(paid).toBe(true);
  });

  it("shields transparent balance", async () => {
    const { wallet, chain } = setup();
    chain.payInto({ payTo: wallet.transparentAddress, amountZat: "20000000", pool: "transparent" });
    chain.mine(1);
    const out = await tool(createTreasuryTools({ wallet }), "byte_shield").func({});
    expect(out).toMatch(/Shielded 19990000/);
  });
});
