import { beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_TESTNET, BytePayerError } from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import { SpendGuard } from "@byte-protocol/client";
import { createMockPair, viewOnly, type MockPair } from "@byte-protocol/wallet";
import {
  PAYMENT_META,
  PAYMENT_REQUIRED_META,
  gateTool,
  paymentRequirementsFrom,
  type McpToolHandler,
  type McpToolRequest,
} from "./gate.js";
import { createPayingToolCaller } from "./client.js";

const SECRET = new Uint8Array(32).fill(31);
const PRICE = "100000";
const SERVER_URL = "https://tools.example.com/mcp";

interface Harness {
  pair: MockPair;
  store: MemoryInvoiceStore;
  gated: McpToolHandler;
  runs: number;
}

function harness(options: { handler?: McpToolHandler } = {}): Harness {
  const pair = createMockPair(NETWORK_TESTNET);
  pair.fundPayer("100000000");
  const store = new MemoryInvoiceStore();
  const wallet = viewOnly(pair.payee);
  const state = { runs: 0 };

  const inner: McpToolHandler =
    options.handler ??
    (async (request) => {
      state.runs += 1;
      return {
        content: [{ type: "text", text: `ran with ${JSON.stringify(request.params.arguments)}` }],
      };
    });

  const gated = gateTool(inner, {
    issuer: new InvoiceIssuer({ wallet, store, secret: SECRET }),
    verifier: new PaymentVerifier({ wallet, store, secret: SECRET }),
    priceZat: PRICE,
  });

  return {
    pair,
    store,
    gated,
    get runs() {
      return state.runs;
    },
  };
}

function call(meta?: Record<string, unknown>): McpToolRequest {
  return {
    params: {
      name: "premium-search",
      arguments: { query: "zcash" },
      ...(meta !== undefined ? { _meta: meta } : {}),
    },
  };
}

describe("gateTool", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("returns payment requirements instead of running the tool", async () => {
    const result = await h.gated(call());

    expect(result.isError).toBe(true);
    expect(h.runs).toBe(0);

    const requirements = paymentRequirementsFrom(result);
    expect(requirements).toMatchObject({ amount: PRICE, asset: "ZEC" });
    expect(requirements?.payTo).toMatch(/^utest1/);
  });

  it("puts the payment in _meta, not in the tool's arguments", async () => {
    // A paid tool's input schema stays its own. Putting payment in arguments would force
    // every paid tool to declare a field it does not care about, and schema-validating
    // clients would reject it.
    const result = await h.gated(call());
    expect(result._meta?.[PAYMENT_REQUIRED_META]).toBeDefined();
    expect(JSON.stringify(result.content)).not.toContain("payTo");
  });

  it("runs the tool once paid and reports the settling transaction", async () => {
    const requirements = paymentRequirementsFrom(await h.gated(call()));
    const { txid } = await h.pair.payer.send({
      to: requirements!.payTo,
      amountZat: PRICE,
      memo: requirements!.memo,
    });
    h.pair.chain.mine(1);

    const result = await h.gated(
      call({ [PAYMENT_META]: { invoiceId: requirements!.invoiceId, txid } }),
    );

    expect(result.isError).toBeUndefined();
    expect(h.runs).toBe(1);
    expect(result._meta?.["byte/txid"]).toBe(txid);
    expect(result.content[0]?.text).toContain("zcash");
  });

  it("refuses a reused payment and does not run the tool again", async () => {
    const requirements = paymentRequirementsFrom(await h.gated(call()));
    const { txid } = await h.pair.payer.send({
      to: requirements!.payTo,
      amountZat: PRICE,
      memo: requirements!.memo,
    });
    h.pair.chain.mine(1);
    const meta = { [PAYMENT_META]: { invoiceId: requirements!.invoiceId, txid } };

    await h.gated(call(meta));
    const replay = await h.gated(call(meta));

    expect(replay.isError).toBe(true);
    expect(replay._meta?.["byte/reason"]).toBe("replay");
    expect(h.runs).toBe(1);
  });

  it("reports an underpayment with a fresh invoice and its shortfall", async () => {
    const requirements = paymentRequirementsFrom(await h.gated(call()));
    const { txid } = await h.pair.payer.send({
      to: requirements!.payTo,
      amountZat: "40000",
      memo: requirements!.memo,
    });
    h.pair.chain.mine(1);

    const result = await h.gated(
      call({ [PAYMENT_META]: { invoiceId: requirements!.invoiceId, txid } }),
    );
    const meta = result._meta?.[PAYMENT_REQUIRED_META] as Record<string, unknown>;

    expect(meta.reason).toBe("underpaid");
    expect(meta.shortfallZat).toBe("60000");
    expect(h.runs).toBe(0);
  });

  it("ignores a malformed payment claim and asks again", async () => {
    for (const bad of [{}, { invoiceId: 1 }, { txid: "x" }, null, "nope"]) {
      const result = await h.gated(call({ [PAYMENT_META]: bad }));
      expect(paymentRequirementsFrom(result)).toBeDefined();
    }
    expect(h.runs).toBe(0);
  });

  it("does not un-consume the invoice when the tool itself throws", async () => {
    // The payment was made and the invoice really is spent. Refunding it here would let a
    // tool that always throws be called for free, forever.
    const failing = harness({
      handler: async () => {
        throw new Error("upstream exploded");
      },
    });
    const requirements = paymentRequirementsFrom(await failing.gated(call()));
    const { txid } = await failing.pair.payer.send({
      to: requirements!.payTo,
      amountZat: PRICE,
      memo: requirements!.memo,
    });
    failing.pair.chain.mine(1);
    const meta = { [PAYMENT_META]: { invoiceId: requirements!.invoiceId, txid } };

    await expect(failing.gated(call(meta))).rejects.toThrow("upstream exploded");
    expect((await failing.store.get(requirements!.invoiceId))?.consumedAt).toBeDefined();
  });
});

describe("createPayingToolCaller", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    // Mine as soon as the payer broadcasts, so the retry finds a confirmed payment.
    const send = h.pair.payer.send.bind(h.pair.payer);
    vi.spyOn(h.pair.payer, "send").mockImplementation(async (request) => {
      const result = await send(request);
      h.pair.chain.mine(1);
      return result;
    });
  });

  it("pays and retries, so the caller sees only the result", async () => {
    const callTool = createPayingToolCaller(h.gated, {
      wallet: h.pair.payer,
      serverUrl: SERVER_URL,
    });

    const result = await callTool(call());
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("zcash");
    expect(h.runs).toBe(1);
  });

  it("preserves the tool's own arguments through the retry", async () => {
    const callTool = createPayingToolCaller(h.gated, {
      wallet: h.pair.payer,
      serverUrl: SERVER_URL,
    });
    const result = await callTool(call());
    expect(result.content[0]?.text).toContain('"query":"zcash"');
  });

  it("passes a genuine tool failure straight through without paying", async () => {
    // A tool that failed is not a tool asking to be paid.
    const before = (await h.pair.payer.balance()).spendableZat;
    const callTool = createPayingToolCaller(
      async () => ({ isError: true, content: [{ type: "text", text: "no such record" }] }),
      { wallet: h.pair.payer, serverUrl: SERVER_URL },
    );

    const result = await callTool(call());
    expect(result.content[0]?.text).toBe("no such record");
    expect((await h.pair.payer.balance()).spendableZat).toBe(before);
  });

  it("does not pay when the guard denies, and the tool never runs", async () => {
    const guard = new SpendGuard({ maxPerCallZat: "1" });
    const callTool = createPayingToolCaller(h.gated, {
      wallet: h.pair.payer,
      guard,
      serverUrl: SERVER_URL,
    });

    await expect(callTool(call())).rejects.toThrow(BytePayerError);
    expect(h.runs).toBe(0);
  });

  it("attributes the spend to the server URL in the audit log", async () => {
    // MCP has no URL at the tool-call layer, so one is supplied. Without it an agent
    // connected to several servers could not tell them apart in its own audit log.
    const guard = new SpendGuard({ maxDailyZat: "10000000" });
    const callTool = createPayingToolCaller(h.gated, {
      wallet: h.pair.payer,
      guard,
      serverUrl: SERVER_URL,
    });

    await callTool(call());
    expect(guard.auditLog().at(-1)).toMatchObject({
      allowed: true,
      host: "tools.example.com",
      amountZat: PRICE,
    });
  });

  it("pays at most once per call by default", async () => {
    // A server that keeps demanding payment must not be able to charge repeatedly.
    let demands = 0;
    const greedy: McpToolHandler = async () => {
      demands += 1;
      const issuer = new InvoiceIssuer({
        wallet: viewOnly(h.pair.payee),
        store: new MemoryInvoiceStore(),
        secret: SECRET,
      });
      return {
        isError: true,
        content: [{ type: "text", text: "pay me" }],
        _meta: { [PAYMENT_REQUIRED_META]: await issuer.issue(PRICE) },
      };
    };

    const before = BigInt((await h.pair.payer.balance()).spendableZat);
    const callTool = createPayingToolCaller(greedy, {
      wallet: h.pair.payer,
      serverUrl: SERVER_URL,
    });

    const result = await callTool(call());
    const after = BigInt((await h.pair.payer.balance()).spendableZat);

    expect(result.isError).toBe(true);
    expect(demands).toBe(2);
    expect(before - after).toBe(BigInt(PRICE) + 10_000n);
  });
});
