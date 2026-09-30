/**
 * The seller that `pnpm seller` runs, driven against the mock chain.
 *
 * The point of that script is to close the three limits the first browser run recorded:
 * no seller verified the payment, the memo was never read back off the chain, and the
 * recipient was known only as the wallet had truncated it. Those are claims about what the
 * seller *answers*, so they are testable here without a funded wallet, and they should be
 * tested here — a seller whose only trial is a live run with real money is a seller nobody
 * has debugged.
 */

import { describe, expect, it } from "vitest";
import { NETWORK_TESTNET } from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import { createMockPair, viewOnly } from "@byte-protocol/wallet";
import { createSellerRoutes, type SellerEvent } from "./seller-routes.js";

const SECRET = new Uint8Array(32).fill(9);
const PRICE = "100000";

function harness(options: { minConfirmations?: number } = {}) {
  const pair = createMockPair(NETWORK_TESTNET);
  const store = new MemoryInvoiceStore();
  const wallet = viewOnly(pair.payee);
  const issuer = new InvoiceIssuer({
    wallet,
    store,
    secret: SECRET,
    minConfirmations: options.minConfirmations ?? 1,
  });
  const verifier = new PaymentVerifier({ wallet, store, secret: SECRET });
  const events: SellerEvent[] = [];
  const routes = createSellerRoutes({
    issuer,
    verifier,
    wallet,
    priceZat: PRICE,
    onEvent: (event) => events.push(event),
  });

  pair.fundPayer("100000000");
  return { pair, routes, events };
}

interface Invoice {
  invoiceId: string;
  payTo: string;
  amount: string;
  memo: string;
  zip321: string;
}

async function getInvoice(h: ReturnType<typeof harness>): Promise<Invoice> {
  const response = await h.routes.handle("POST", "/invoice", "");
  expect(response?.status).toBe(200);
  return response?.body as Invoice;
}

async function settle(
  h: ReturnType<typeof harness>,
  invoiceId: string,
  txid: string,
): Promise<Record<string, unknown>> {
  const response = await h.routes.handle(
    "POST",
    "/settle",
    JSON.stringify({ invoiceId, txid }),
  );
  expect(response?.status).toBe(200);
  return response?.body as Record<string, unknown>;
}

describe("issuing an invoice", () => {
  it("mints a real one, bound to the seller's own key", async () => {
    const h = harness();
    const invoice = await getInvoice(h);

    expect(invoice.invoiceId).toMatch(/^[0-9a-f]{32}$/);
    expect(invoice.amount).toBe(PRICE);
    expect(invoice.payTo).not.toBe("");
    // The ZIP 321 request is what the page hands the wallet, so it must carry both the
    // address and the memo or the payment cannot bind to the invoice.
    expect(invoice.zip321).toContain(invoice.payTo);
    expect(invoice.memo).toMatch(/^BYTE1\|/);
  });

  it("mints a different address for every invoice", async () => {
    const h = harness();
    const first = await getInvoice(h);
    const second = await getInvoice(h);
    expect(first.payTo).not.toBe(second.payTo);
    expect(first.invoiceId).not.toBe(second.invoiceId);
  });

  it("records what it issued", async () => {
    const h = harness();
    const invoice = await getInvoice(h);
    expect(h.routes.issued.get(invoice.invoiceId)).toEqual({
      payTo: invoice.payTo,
      amountZat: PRICE,
    });
    expect(h.events).toContainEqual({
      kind: "issued",
      invoiceId: invoice.invoiceId,
      amountZat: PRICE,
      payTo: invoice.payTo,
    });
  });
});

describe("a payment that settles the invoice", () => {
  it("is verified, and answers the three things the browser could not", async () => {
    const h = harness();
    const invoice = await getInvoice(h);

    const { txid } = await h.pair.payer.send({
      to: invoice.payTo,
      amountZat: invoice.amount,
      memo: invoice.memo,
    });
    h.pair.chain.mine(1);

    const body = await settle(h, invoice.invoiceId, txid);

    // 1. A seller verified it, against its own record of the invoice it issued.
    expect(body.ok).toBe(true);

    // 2. The memo was read back off the chain, with the seller's viewing key.
    const outputs = body.outputs as Array<{ pool: string; memo: string | null; valueZat: string }>;
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.some((o) => o.memo === invoice.memo)).toBe(true);
    expect(body.everyOutputInIronwood).toBe(true);

    // 3. The recipient is reported in full, not as a wallet chose to truncate it.
    // Equal to the address the seller issued, character for character. The wallet's own
    // display is what was truncated, so the test that matters is that nothing here
    // shortens or elides it — not that the string is long, which would only be a fact
    // about the mock's address format.
    expect(body.payTo).toBe(invoice.payTo);
    expect(String(body.payTo)).not.toMatch(/[.…]{3}|…/);

    expect(h.events).toContainEqual({ kind: "settled", invoiceId: invoice.invoiceId, txid });
    expect(h.routes.issued.get(invoice.invoiceId)?.settledBy).toBe(txid);
  });

  it("reports the value that actually arrived, not the value that was asked for", async () => {
    const h = harness();
    const invoice = await getInvoice(h);
    const { txid } = await h.pair.payer.send({
      to: invoice.payTo,
      amountZat: invoice.amount,
      memo: invoice.memo,
    });
    h.pair.chain.mine(1);

    const body = await settle(h, invoice.invoiceId, txid);
    const outputs = body.outputs as Array<{ valueZat: string }>;
    expect(outputs.some((o) => o.valueZat === PRICE)).toBe(true);
  });
});

describe("a payment that does not settle the invoice", () => {
  it("is not yet valid while it is unconfirmed, which is not a failure", async () => {
    const h = harness({ minConfirmations: 2 });
    const invoice = await getInvoice(h);
    const { txid } = await h.pair.payer.send({
      to: invoice.payTo,
      amountZat: invoice.amount,
      memo: invoice.memo,
    });
    h.pair.chain.mine(1);

    const body = await settle(h, invoice.invoiceId, txid);
    expect(body.ok).toBe(false);
    // The outputs are still reported, so the page can show the payment is on the chain
    // and merely waiting. Answering "no" with no detail is what made this confusing.
    expect((body.outputs as unknown[]).length).toBeGreaterThan(0);

    h.pair.chain.mine(1);
    expect((await settle(h, invoice.invoiceId, txid)).ok).toBe(true);
  });

  it("refuses an underpayment", async () => {
    const h = harness();
    const invoice = await getInvoice(h);
    const { txid } = await h.pair.payer.send({
      to: invoice.payTo,
      amountZat: "1",
      memo: invoice.memo,
    });
    h.pair.chain.mine(1);

    expect((await settle(h, invoice.invoiceId, txid)).ok).toBe(false);
  });

  it("refuses a payment carrying no memo, so nothing binds it to the invoice", async () => {
    const h = harness();
    const invoice = await getInvoice(h);
    const { txid } = await h.pair.payer.send({ to: invoice.payTo, amountZat: invoice.amount });
    h.pair.chain.mine(1);

    expect((await settle(h, invoice.invoiceId, txid)).ok).toBe(false);
  });

  it("refuses an unknown invoice without saying whether any invoice exists", async () => {
    const h = harness();
    const body = await settle(h, "f".repeat(32), "a".repeat(64));
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain("does not exist");
  });

  it("refuses to settle the same invoice twice", async () => {
    const h = harness();
    const invoice = await getInvoice(h);
    const { txid } = await h.pair.payer.send({
      to: invoice.payTo,
      amountZat: invoice.amount,
      memo: invoice.memo,
    });
    h.pair.chain.mine(1);

    expect((await settle(h, invoice.invoiceId, txid)).ok).toBe(true);
    const replay = await settle(h, invoice.invoiceId, txid);
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe("replay");
  });
});

describe("the HTTP surface itself", () => {
  it("answers nothing for a route it does not have, so the caller owns the 404", async () => {
    const h = harness();
    expect(await h.routes.handle("GET", "/nope", "")).toBeNull();
    expect(await h.routes.handle("GET", "/invoice", "")).toBeNull();
  });

  it.each([
    ["not JSON at all", "<html>"],
    ["JSON that is not an object", '"hello"'],
    ["an object missing both fields", "{}"],
    ["a numeric invoiceId", '{"invoiceId":1,"txid":"a"}'],
    ["a missing txid", '{"invoiceId":"a"}'],
  ])("rejects a settle body that is %s", async (_label, body) => {
    const h = harness();
    const response = await h.routes.handle("POST", "/settle", body);
    expect(response?.status).toBe(400);
  });
});
