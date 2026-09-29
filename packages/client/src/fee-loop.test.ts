/**
 * The full 402 loop with a facilitator fee, over real HTTP.
 *
 * This test exists because of a defect it would have caught immediately. The fee output
 * was built into the invoice and into the verifier, but nothing in the payer path could
 * produce a second output: `SendRequest` carried one `to`/`amountZat`/`memo`, `BytePayer`
 * sent one output, and the sidecar built a one-recipient proposal. **Every fee-carrying
 * invoice was unpayable by Byte's own client**, and the suite was green because the fee
 * test hand-credited the fee leg onto the chain instead of going through the payer.
 *
 * So: a real HTTP server, a real issuer with a fee configured, a real verifier checking
 * both outputs, and `createByteFetch` doing the paying. Nothing stubbed but the chain.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_TESTNET, parseZip321Multi } from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import { MockChain, MockWallet, viewOnly } from "@byte-protocol/wallet";
import {
  BYTE_PAYMENT_HEADER,
  BYTE_REQUIREMENTS_HEADER,
  createByteFetch,
  decodePaymentHeader,
  encodeRequirementsHeader,
} from "./fetch.js";
import { SpendGuard } from "./guard.js";
import { BytePayer } from "./payer.js";

const SECRET = new Uint8Array(32).fill(17);
const PRICE = "10000000";
const FEE_BPS = 100;

/**
 * Payee, payer and facilitator, each with its own wallet.
 *
 * Three, because the fee genuinely goes to a third party: the payee's viewing key cannot
 * see the facilitator's fee address, and a harness where one wallet saw both would be
 * testing a deployment nobody can run.
 */
function wallets() {
  const chain = new MockChain();
  const payee = new MockWallet({ network: NETWORK_TESTNET, chain, addressPrefix: "utest1payee" });
  const payer = new MockWallet({ network: NETWORK_TESTNET, chain, addressPrefix: "utest1payer" });
  const facilitator = new MockWallet({
    network: NETWORK_TESTNET,
    chain,
    addressPrefix: "utest1facil",
  });
  chain.payInto({ payTo: payer.fundingAddress, amountZat: "1000000000" });
  chain.mine(1);
  return { chain, payee, payer, facilitator };
}

async function startSeller(w: ReturnType<typeof wallets>, options: { fee?: boolean } = {}) {
  const store = new MemoryInvoiceStore();
  const wallet = viewOnly(w.payee);
  const issuer = new InvoiceIssuer({
    wallet,
    store,
    secret: SECRET,
    ...(options.fee !== false
      ? { facilitatorFee: { bps: FEE_BPS, payTo: w.facilitator.fundingAddress } }
      : {}),
  });
  const verifier = new PaymentVerifier({
    wallet,
    store,
    secret: SECRET,
    feeWallet: viewOnly(w.facilitator),
  });

  const state = { served: 0, lastRefusal: undefined as string | undefined };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const payload = (() => {
        try {
          return decodePaymentHeader(
            (req.headers[BYTE_PAYMENT_HEADER] as string | undefined) ?? null,
          );
        } catch {
          return undefined;
        }
      })();

      const send402 = async (extra: Record<string, unknown> = {}) => {
        const invoice = await issuer.issue(PRICE);
        res.writeHead(402, {
          "content-type": "application/json",
          [BYTE_REQUIREMENTS_HEADER]: encodeRequirementsHeader(invoice),
        });
        res.end(JSON.stringify({ accepts: [invoice], ...extra }));
      };

      const claim = payload as { invoiceId?: string; txid?: string } | undefined;
      if (claim?.invoiceId === undefined || claim.txid === undefined) {
        await send402();
        return;
      }

      const result = await verifier.verify(claim.invoiceId, claim.txid);
      if (!result.ok) {
        state.lastRefusal = result.reason;
        await send402({ reason: result.reason, message: result.message });
        return;
      }

      state.served += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ secret: "the paid resource" }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");

  return { server, origin: `http://127.0.0.1:${address.port}`, store, state };
}

describe("a fee-carrying invoice, end to end", () => {
  let w: ReturnType<typeof wallets>;
  let seller: Awaited<ReturnType<typeof startSeller>>;

  beforeEach(async () => {
    w = wallets();
    seller = await startSeller(w);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => seller.server.close(() => resolve()));
  });

  /** Mine as soon as the payer broadcasts, so the retry finds a confirmed payment. */
  function mineOnSend() {
    const send = w.payer.send.bind(w.payer);
    vi.spyOn(w.payer, "send").mockImplementation(async (request) => {
      const result = await send(request);
      w.chain.mine(1);
      return result;
    });
  }

  it("is paid and served", async () => {
    mineOnSend();
    const pay = createByteFetch({ wallet: w.payer });

    const response = await pay(`${seller.origin}/resource`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ secret: "the paid resource" });
    expect(seller.state.served).toBe(1);
  });

  it("settles both outputs in one transaction", async () => {
    // Atomicity is the whole reason the fee check means anything: the payee's output and
    // the fee output arrive together or neither does. Two broadcasts could not give that.
    mineOnSend();
    const pay = createByteFetch({ wallet: w.payer });
    await pay(`${seller.origin}/resource`);

    const { invoices } = await seller.store.list({ limit: 10 });
    const settled = invoices.find((i) => i.consumedAt !== undefined);
    expect(settled).toBeDefined();

    const outputs = await w.payer.findOutputs(settled?.txid ?? "");
    expect(outputs).toHaveLength(2);

    const byAddress = new Map(outputs.map((o) => [o.payTo, o.valueZat]));
    expect(byAddress.get(settled?.payTo ?? "")).toBe(PRICE);
    expect(byAddress.get(w.facilitator.fundingAddress)).toBe("100000");
  });

  it("puts both outputs in the ZIP-321 request the payer was handed", async () => {
    const response = await globalThis.fetch(`${seller.origin}/resource`);
    const body = (await response.json()) as { accepts: Array<{ zip321: string }> };

    const payments = parseZip321Multi(body.accepts[0]?.zip321 ?? "");
    expect(payments).toHaveLength(2);
    expect(payments[1]?.address).toBe(w.facilitator.fundingAddress);
  });

  it("charges the guard the payment plus the fee, not the payment alone", async () => {
    // A fee slipping past a per-call cap would defeat the point of setting one: the cap
    // exists to bound what a single request can cost, and the fee is part of that cost.
    mineOnSend();
    const guard = new SpendGuard({ maxDailyZat: "100000000" });
    const pay = createByteFetch({ wallet: w.payer, guard });

    await pay(`${seller.origin}/resource`);

    expect(guard.spentTodayZat()).toBe("10100000");
  });

  it("is refused by a per-call cap that the payment alone would have passed", async () => {
    // 10,000,000 is exactly the invoice. With the fee the call costs 10,100,000, so a cap
    // set at the invoice amount must refuse it rather than quietly overspending.
    const guard = new SpendGuard({ maxPerCallZat: PRICE });
    const pay = createByteFetch({ wallet: w.payer, guard });

    await expect(pay(`${seller.origin}/resource`)).rejects.toThrow(/exceeds the per-call cap/);
    expect(seller.state.served).toBe(0);
  });

  it("refuses to pay an invoice asking more fee than its own terms allow", async () => {
    // A server that names its terms and then asks for a different number is either broken
    // or helping itself, and the payer is the only party positioned to notice.
    const payer = new BytePayer({ wallet: w.payer });
    const response = await globalThis.fetch(`${seller.origin}/resource`);
    const body = (await response.json()) as { accepts: Array<Record<string, unknown>> };
    const invoice = body.accepts[0] as Record<string, unknown>;

    const greedy = {
      ...invoice,
      fee: { ...(invoice.fee as Record<string, unknown>), amount: "99000000" },
    };

    await expect(payer.pay(greedy, seller.origin)).rejects.toThrow(/come to 100000/);
  });
});

describe("a payment that skips the fee", () => {
  it("is refused, and the invoice stays open", async () => {
    // Nothing on-chain requires the second output. This check is the only thing that does,
    // which is exactly what "enforced by the facilitator, not by the chain" means.
    const w = wallets();
    const seller = await startSeller(w);

    try {
      const response = await globalThis.fetch(`${seller.origin}/resource`);
      const body = (await response.json()) as {
        accepts: Array<{ invoiceId: string; payTo: string; amount: string; memo: string }>;
      };
      const invoice = body.accepts[0];
      if (invoice === undefined) throw new Error("no invoice");

      // Pay the payee only, as a payer bypassing the facilitator would.
      const { txid } = await w.payer.send({
        to: invoice.payTo,
        amountZat: invoice.amount,
        memo: invoice.memo,
      });
      w.chain.mine(1);

      const retry = await globalThis.fetch(`${seller.origin}/resource`, {
        headers: {
          [BYTE_PAYMENT_HEADER]: Buffer.from(
            JSON.stringify({ invoiceId: invoice.invoiceId, txid }),
          ).toString("base64"),
        },
      });

      expect(retry.status).toBe(402);
      expect(seller.state.lastRefusal).toBe("underpaid");
      expect(seller.state.served).toBe(0);

      // And the invoice is still payable: refusing must not strand the payer's money.
      const stored = await seller.store.get(invoice.invoiceId);
      expect(stored?.consumedAt).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => seller.server.close(() => resolve()));
    }
  });
});
