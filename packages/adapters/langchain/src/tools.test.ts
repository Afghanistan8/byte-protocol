import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_TESTNET } from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import { SpendGuard } from "@byte-protocol/client";
import { createMockPair, viewOnly, type MockPair } from "@byte-protocol/wallet";
import {
  createBalanceTool,
  createByteTools,
  createFetchPaidTool,
  createSpendReportTool,
} from "./tools.js";

const SECRET = new Uint8Array(32).fill(53);
const PRICE = "100000";

/** A Byte-gated resource server, written out so the test depends only on the protocol. */
async function startSeller(pair: MockPair) {
  const store = new MemoryInvoiceStore();
  const wallet = viewOnly(pair.payee);
  const issuer = new InvoiceIssuer({ wallet, store, secret: SECRET });
  const verifier = new PaymentVerifier({ wallet, store, secret: SECRET });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const header = req.headers["payment-signature"] as string | undefined;
      const claim = header
        ? (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
            invoiceId: string;
            txid: string;
          })
        : undefined;

      if (claim !== undefined) {
        const result = await verifier.verify(claim.invoiceId, claim.txid);
        if (result.ok) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("the paid answer is 42");
          return;
        }
      }

      const invoice = await issuer.issue(PRICE);
      res.writeHead(402, {
        "content-type": "application/json",
        "payment-required": Buffer.from(JSON.stringify(invoice), "utf8").toString("base64"),
      });
      res.end(JSON.stringify({ accepts: [invoice] }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("tool definitions", () => {
  let pair: MockPair;
  beforeEach(() => {
    pair = createMockPair(NETWORK_TESTNET);
  });

  it("returns the shape DynamicStructuredTool takes", () => {
    // name, description, schema, func — so wiring is `new DynamicStructuredTool(t)` and the
    // adapter never pins an agent's LangChain version.
    for (const tool of createByteTools({ wallet: pair.payer, guard: {} })) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.func).toBe("function");
      expect(tool.schema).toBeDefined();
      expect(tool.schema.safeParse({})).toBeDefined();
    }
  });

  it("says plainly that fetching costs money", () => {
    // The description is the only thing a model reads before deciding to call a tool.
    const tool = createFetchPaidTool({ wallet: pair.payer });
    expect(tool.description).toMatch(/SPENDS REAL MONEY/);
  });

  it("omits the spend report when there is no guard", () => {
    // Without limits there are no refusals to explain and nothing to report.
    const names = (guard?: object) =>
      createByteTools({ wallet: pair.payer, ...(guard ? { guard } : {}) }).map((t) => t.name);

    expect(names()).toEqual(["byte_fetch_paid", "byte_balance"]);
    expect(names({})).toContain("byte_spend_report");
  });
});

describe("byte_balance", () => {
  let pair: MockPair;
  beforeEach(() => {
    pair = createMockPair(NETWORK_TESTNET);
  });

  it("reports spendable, pending and unusable separately", async () => {
    // Collapsing them would tell a model it has funds it cannot actually send.
    pair.fundPayer("500000");
    pair.fundPayer("300000", { pool: "transparent" });
    pair.fundPayer("200000", { confirm: false });

    const text = await createBalanceTool({ wallet: pair.payer }).func({});
    expect(text).toContain("Spendable: 500000");
    expect(text).toContain("Pending (not yet confirmed): 200000");
    expect(text).toContain("Unusable");
    expect(text).toContain("300000");
  });

  it("warns when the wallet is not synced", async () => {
    vi.spyOn(pair.payer, "status").mockResolvedValue({
      network: NETWORK_TESTNET,
      syncedHeight: 10,
      synced: false,
    });
    const text = await createBalanceTool({ wallet: pair.payer }).func({});
    expect(text).toContain("WARNING");
    vi.restoreAllMocks();
  });
});

describe("byte_fetch_paid", () => {
  let pair: MockPair;
  let seller: Awaited<ReturnType<typeof startSeller>>;

  beforeEach(async () => {
    pair = createMockPair(NETWORK_TESTNET);
    pair.fundPayer("100000000");
    seller = await startSeller(pair);

    const send = pair.payer.send.bind(pair.payer);
    vi.spyOn(pair.payer, "send").mockImplementation(async (request) => {
      const result = await send(request);
      pair.chain.mine(1);
      return result;
    });
  });

  afterEach(async () => {
    await seller.close();
    vi.restoreAllMocks();
  });

  it("pays for a resource and returns its body", async () => {
    const tool = createFetchPaidTool({ wallet: pair.payer });
    const text = await tool.func({ url: `${seller.origin}/premium`, method: "GET" });
    expect(text).toBe("the paid answer is 42");
  });

  it("returns a message instead of throwing when the guard refuses", async () => {
    // A tool that throws tends to end an agent's run. "I was not allowed to spend that
    // much" is something the model should be able to act on.
    const guard = new SpendGuard({ maxPerCallZat: "1" });
    const tool = createFetchPaidTool({ wallet: pair.payer, guard });

    const text = await tool.func({ url: `${seller.origin}/premium`, method: "GET" });
    expect(text).toMatch(/payment did not happen/i);
    expect(text).toMatch(/per-call cap/i);
  });

  it("returns a message when the host is not allowed", async () => {
    const guard = new SpendGuard({ allow: ["example.com"] });
    const tool = createFetchPaidTool({ wallet: pair.payer, guard });
    const text = await tool.func({ url: `${seller.origin}/premium`, method: "GET" });
    expect(text).toMatch(/not in the allow list/i);
  });

  it("reports an unreachable host rather than throwing", async () => {
    const tool = createFetchPaidTool({ wallet: pair.payer });
    const text = await tool.func({ url: "http://127.0.0.1:1/nothing", method: "GET" });
    expect(text).toMatch(/payment did not happen/i);
  });
});

describe("byte_spend_report", () => {
  let pair: MockPair;
  beforeEach(() => {
    pair = createMockPair(NETWORK_TESTNET);
  });

  it("reports nothing attempted on a fresh guard", async () => {
    const text = await createSpendReportTool(new SpendGuard()).func({});
    expect(text).toBe("No payments have been attempted.");
  });

  it("lists refusals as well as payments", async () => {
    // An agent that can see it was denied can explain that; one that only sees successes
    // will keep retrying the same denied call.
    const guard = new SpendGuard({ maxPerCallZat: "1000" });
    await guard.authorize({ amountZat: "500", url: "https://ok.example.com/x" });
    await guard.authorize({ amountZat: "5000", url: "https://pricey.example.com/x" });

    const text = await createSpendReportTool(guard).func({});
    expect(text).toContain("PAID     500 zat to ok.example.com");
    expect(text).toContain("REFUSED  5000 zat to pricey.example.com (over_per_call_cap)");
    expect(text).toContain("Spent in the last 24 hours: 500 zatoshis");
  });
});
