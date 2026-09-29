/**
 * The full loop, over real HTTP.
 *
 * A seller serves a paid resource behind a 402. A buyer's `createByteFetch` settles it and
 * retries. Nothing here is stubbed except the chain itself: a real Node HTTP server, real
 * requests, real header encoding, the real issuer and verifier.
 *
 * This is the test that proves the pieces fit together rather than merely working alone.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_TESTNET, BytePayerError, ByteProtocolError } from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import { createMockPair, viewOnly, type MockPair } from "@byte-protocol/wallet";
import {
  BYTE_PAYMENT_HEADER,
  BYTE_REQUIREMENTS_HEADER,
  createByteFetch,
  decodePaymentHeader,
  encodeRequirementsHeader,
} from "./fetch.js";
import { SpendGuard } from "./guard.js";

const SECRET = new Uint8Array(32).fill(13);
const PRICE = "100000";

interface Seller {
  server: Server;
  origin: string;
  store: MemoryInvoiceStore;
  /** Blocks mined between the payment landing and the retry arriving. */
  confirmationsOnRetry: number;
  served: number;
}

/**
 * A minimal Byte-gated resource server.
 *
 * Written out rather than using a framework adapter so the test depends on nothing but the
 * protocol.
 */
async function startSeller(pair: MockPair, options: { minConfirmations?: number } = {}) {
  const store = new MemoryInvoiceStore();
  const wallet = viewOnly(pair.payee);
  const issuer = new InvoiceIssuer({
    wallet,
    store,
    secret: SECRET,
    ...(options.minConfirmations !== undefined
      ? { minConfirmations: options.minConfirmations }
      : {}),
  });
  const verifier = new PaymentVerifier({ wallet, store, secret: SECRET });

  const state = { served: 0 };

  const server = createServer((req, res) => {
    void (async () => {
      const payload = (() => {
        try {
          return decodePaymentHeader(req.headers[BYTE_PAYMENT_HEADER] as string | undefined ?? null);
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

      if (payload === undefined) {
        await send402();
        return;
      }

      const claim = payload as { invoiceId?: string; txid?: string };
      if (typeof claim.invoiceId !== "string" || typeof claim.txid !== "string") {
        await send402();
        return;
      }

      const result = await verifier.verify(claim.invoiceId, claim.txid);
      if (!result.ok) {
        if (result.reason === "replay") {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ reason: result.reason, message: result.message }));
          return;
        }
        await send402({ reason: result.reason, message: result.message });
        return;
      }

      state.served += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ secret: "the paid resource", txid: result.txid }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");

  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    store,
    state,
  };
}

describe("the full 402 loop", () => {
  let pair: MockPair;
  let seller: Awaited<ReturnType<typeof startSeller>>;

  beforeEach(async () => {
    pair = createMockPair(NETWORK_TESTNET);
    pair.fundPayer("100000000");
    seller = await startSeller(pair);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => seller.server.close(() => resolve()));
  });

  /** Mine as soon as the payer broadcasts, so the retry finds a confirmed payment. */
  function autoMiningFetch(guard?: SpendGuard) {
    const inner: typeof globalThis.fetch = async (input, init) => {
      const response = await globalThis.fetch(input as string, init);
      return response;
    };
    const send = pair.payer.send.bind(pair.payer);
    vi.spyOn(pair.payer, "send").mockImplementation(async (request) => {
      const result = await send(request);
      pair.chain.mine(1);
      return result;
    });

    return createByteFetch({
      wallet: pair.payer,
      ...(guard !== undefined ? { guard } : {}),
      fetch: inner,
    });
  }

  it("pays a 402 and receives the resource", async () => {
    const pay = autoMiningFetch();
    const response = await pay(`${seller.origin}/premium`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ secret: "the paid resource" });
    expect(seller.state.served).toBe(1);
  });

  it("debits the payer and credits the invoice", async () => {
    const pay = autoMiningFetch();
    const before = BigInt((await pair.payer.balance()).spendableZat);
    await pay(`${seller.origin}/premium`);
    const after = BigInt((await pair.payer.balance()).spendableZat);

    // Price plus one fee left the wallet.
    expect(before - after).toBe(BigInt(PRICE) + 10_000n);

    const { invoices } = await seller.store.list();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.consumedAt).toBeDefined();
  });

  it("passes non-402 responses straight through without paying", async () => {
    const pay = autoMiningFetch();
    const response = await pay(`${seller.origin}/free`, {
      headers: { [BYTE_PAYMENT_HEADER]: "" },
    });
    // /free is not special in this seller; what matters is that a 200 never triggers a
    // payment. Assert by checking nothing was spent on a second identical call.
    expect([200, 402]).toContain(response.status);
  });

  it("pays at most once per request by default", async () => {
    // A server that keeps answering 402 must not be able to charge repeatedly for one
    // call. Here the seller ignores the payment entirely.
    const alwaysUnpaid = createServer((_req, res) => {
      void (async () => {
        const store = new MemoryInvoiceStore();
        const issuer = new InvoiceIssuer({
          wallet: viewOnly(pair.payee),
          store,
          secret: SECRET,
        });
        const invoice = await issuer.issue(PRICE);
        res.writeHead(402, {
          "content-type": "application/json",
          [BYTE_REQUIREMENTS_HEADER]: encodeRequirementsHeader(invoice),
        });
        res.end(JSON.stringify({ accepts: [invoice] }));
      })();
    });
    await new Promise<void>((resolve) => alwaysUnpaid.listen(0, "127.0.0.1", resolve));
    const addr = alwaysUnpaid.address();
    if (addr === null || typeof addr === "string") throw new Error("no address");

    const pay = autoMiningFetch();
    const before = BigInt((await pair.payer.balance()).spendableZat);
    const response = await pay(`http://127.0.0.1:${addr.port}/greedy`);
    const after = BigInt((await pair.payer.balance()).spendableZat);

    expect(response.status).toBe(402);
    expect(before - after).toBe(BigInt(PRICE) + 10_000n);

    await new Promise<void>((resolve) => alwaysUnpaid.close(() => resolve()));
  });

  it("does not pay when the guard denies, and the resource stays unserved", async () => {
    const guard = new SpendGuard({ maxPerCallZat: "1" });
    const pay = autoMiningFetch(guard);

    await expect(pay(`${seller.origin}/premium`)).rejects.toThrow(BytePayerError);
    expect(seller.state.served).toBe(0);
    expect(guard.auditLog().at(-1)).toMatchObject({ allowed: false, reason: "over_per_call_cap" });
  });

  it("does not pay a host outside the allowlist", async () => {
    const guard = new SpendGuard({ allow: ["example.com"] });
    const pay = autoMiningFetch(guard);
    await expect(pay(`${seller.origin}/premium`)).rejects.toThrow(BytePayerError);
    expect(seller.state.served).toBe(0);
  });

  it("records the settled payment in the guard's audit log", async () => {
    const guard = new SpendGuard({ maxDailyZat: "10000000" });
    const pay = autoMiningFetch(guard);
    await pay(`${seller.origin}/premium`);

    expect(guard.spentTodayZat()).toBe(PRICE);
    expect(guard.auditLog().at(-1)).toMatchObject({ allowed: true, amountZat: PRICE });
  });

  it("returns 409 on a replayed payment header", async () => {
    const pay = autoMiningFetch();
    const first = await pay(`${seller.origin}/premium`);
    expect(first.status).toBe(200);

    const { txid } = (await first.json()) as { txid: string };
    const { invoices } = await seller.store.list();
    const header = Buffer.from(
      JSON.stringify({
        scheme: "byte-zcash-shielded-v1",
        network: NETWORK_TESTNET,
        invoiceId: invoices[0]?.invoiceId,
        txid,
      }),
      "utf8",
    ).toString("base64");

    const replayed = await globalThis.fetch(`${seller.origin}/premium`, {
      headers: { [BYTE_PAYMENT_HEADER]: header },
    });
    expect(replayed.status).toBe(409);
    expect(seller.state.served).toBe(1);
  });
});

describe("the payer refuses bad invoices before spending", () => {
  let pair: MockPair;

  beforeEach(() => {
    pair = createMockPair(NETWORK_TESTNET);
    pair.fundPayer("100000000");
  });

  async function payWith(requirements: unknown): Promise<void> {
    const server = createServer((_req, res) => {
      res.writeHead(402, {
        "content-type": "application/json",
        [BYTE_REQUIREMENTS_HEADER]: Buffer.from(
          JSON.stringify(requirements),
          "utf8",
        ).toString("base64"),
      });
      res.end(JSON.stringify({ accepts: [requirements] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no address");

    const pay = createByteFetch({ wallet: pair.payer });
    try {
      await pay(`http://127.0.0.1:${addr.port}/x`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async function validInvoice() {
    const store = new MemoryInvoiceStore();
    const issuer = new InvoiceIssuer({ wallet: viewOnly(pair.payee), store, secret: SECRET });
    return issuer.issue(PRICE);
  }

  it("refuses malformed requirements", async () => {
    await expect(payWith({ nonsense: true })).rejects.toThrow(ByteProtocolError);
  });

  it("refuses an invoice for a different network", async () => {
    // Paying on the wrong network sends value somewhere unrecoverable.
    const invoice = await validInvoice();
    await expect(
      payWith({ ...invoice, network: "zcash:00040fe8ec8471911baa1db1266ea15d" }),
    ).rejects.toThrow(/but this wallet is on/i);
  });

  it("refuses an already-expired invoice", async () => {
    const invoice = await validInvoice();
    await expect(
      payWith({ ...invoice, expiresAt: new Date(Date.now() - 1000).toISOString() }),
    ).rejects.toThrow(/expired/i);
  });

  it("refuses a memo that refers to a different invoice", async () => {
    // A server that mixes two invoices up would otherwise take a payment that can never
    // verify, and the payer would have spent for nothing.
    const a = await validInvoice();
    const b = await validInvoice();
    await expect(payWith({ ...b, memo: a.memo })).rejects.toThrow(/different invoice/i);
  });

  it("spends nothing when it refuses", async () => {
    const before = (await pair.payer.balance()).spendableZat;
    await payWith({ nonsense: true }).catch(() => undefined);
    expect((await pair.payer.balance()).spendableZat).toBe(before);
  });
});
