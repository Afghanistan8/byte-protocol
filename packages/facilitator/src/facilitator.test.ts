import { beforeEach, describe, expect, it } from "vitest";
import { NETWORK_TESTNET } from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { MockWallet, createMockPair, viewOnly, type MockPair } from "@byte-protocol/wallet";
import { BytePayer } from "@byte-protocol/client";
import { ByteFacilitator } from "./facilitator.js";
import { API_KEY_HEADER, createFacilitatorHandler } from "./http.js";

const SECRET = new Uint8Array(32).fill(17);
const API_KEY = "a".repeat(32);

interface Harness {
  pair: MockPair;
  store: MemoryInvoiceStore;
  facilitator: ByteFacilitator;
  handle: ReturnType<typeof createFacilitatorHandler>;
}

function harness(): Harness {
  const pair = createMockPair(NETWORK_TESTNET);
  pair.fundPayer("100000000");
  const store = new MemoryInvoiceStore();
  const facilitator = new ByteFacilitator({
    wallet: viewOnly(pair.payee),
    store,
    secret: SECRET,
    apiKey: API_KEY,
  });
  return { pair, store, facilitator, handle: createFacilitatorHandler(facilitator) };
}

function request(
  method: string,
  path: string,
  options: { key?: string | null; body?: unknown } = {},
) {
  const key = options.key === undefined ? API_KEY : options.key;
  return {
    method,
    path,
    header: (name: string) => (name === API_KEY_HEADER ? key : null),
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

describe("construction", () => {
  it("refuses a wallet that can spend", () => {
    // The facilitator's whole security argument is that it cannot spend. Silently
    // accepting spend capability would void it.
    const pair = createMockPair(NETWORK_TESTNET);
    expect(
      () =>
        new ByteFacilitator({
          wallet: pair.payee,
          store: new MemoryInvoiceStore(),
          secret: SECRET,
          apiKey: API_KEY,
        }),
    ).toThrow(/view-only/);
  });

  it("accepts a view-only wallet", () => {
    expect(() => harness()).not.toThrow();
  });

  it("refuses a short API key", () => {
    const pair = createMockPair(NETWORK_TESTNET);
    expect(
      () =>
        new ByteFacilitator({
          wallet: viewOnly(pair.payee),
          store: new MemoryInvoiceStore(),
          secret: SECRET,
          apiKey: "short",
        }),
    ).toThrow(/at least 32/);
  });
});

describe("authorization", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("reports health without a key", async () => {
    const response = await h.handle(request("GET", "/health", { key: null }));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, synced: true });
  });

  it("rejects every other route without a valid key", async () => {
    for (const [method, path] of [
      ["GET", "/info"],
      ["POST", "/invoices"],
      ["POST", "/verify"],
    ] as const) {
      const response = await h.handle(request(method, path, { key: "wrong-key-value-here-32ch" }));
      expect(response.status).toBe(401);
    }
    expect((await h.handle(request("GET", "/info", { key: null }))).status).toBe(401);
  });

  it("accepts the exact key and nothing close to it", async () => {
    expect((await h.handle(request("GET", "/info"))).status).toBe(200);
    expect((await h.handle(request("GET", "/info", { key: API_KEY + "x" }))).status).toBe(401);
    expect((await h.handle(request("GET", "/info", { key: API_KEY.slice(0, -1) }))).status).toBe(
      401,
    );
  });
});

describe("info", () => {
  it("states that it cannot spend", async () => {
    // Callers can assert this rather than taking it on trust.
    const h = harness();
    const response = await h.handle(request("GET", "/info"));
    expect(response.body).toMatchObject({
      scheme: "byte-zcash-shielded-v1",
      network: NETWORK_TESTNET,
      canSpend: false,
    });
  });
});

describe("invoices and verification", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("issues an invoice and verifies its payment", async () => {
    const issued = await h.handle(request("POST", "/invoices", { body: { amountZat: "100000" } }));
    expect(issued.status).toBe(200);
    const invoice = issued.body as { invoiceId: string; payTo: string; memo: string };

    const { txid } = await h.pair.payer.send({
      to: invoice.payTo,
      amountZat: "100000",
      memo: invoice.memo,
    });
    h.pair.chain.mine(1);

    const verified = await h.handle(
      request("POST", "/verify", { body: { invoiceId: invoice.invoiceId, txid } }),
    );
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ ok: true, pool: "ironwood", amountZat: "100000" });
  });

  it("returns 409 for a replay and 402 for everything else", async () => {
    const issued = await h.handle(request("POST", "/invoices", { body: { amountZat: "100000" } }));
    const invoice = issued.body as { invoiceId: string; payTo: string; memo: string };

    const { txid } = await h.pair.payer.send({
      to: invoice.payTo,
      amountZat: "100000",
      memo: invoice.memo,
    });
    h.pair.chain.mine(1);

    const first = await h.handle(
      request("POST", "/verify", { body: { invoiceId: invoice.invoiceId, txid } }),
    );
    expect(first.status).toBe(200);

    const replay = await h.handle(
      request("POST", "/verify", { body: { invoiceId: invoice.invoiceId, txid } }),
    );
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ reason: "replay" });

    const unknown = await h.handle(
      request("POST", "/verify", { body: { invoiceId: "0".repeat(32), txid } }),
    );
    expect(unknown.status).toBe(402);
    expect(unknown.body).toMatchObject({ reason: "invalid_payment" });
  });

  it("reports an underpayment with its shortfall", async () => {
    const issued = await h.handle(request("POST", "/invoices", { body: { amountZat: "100000" } }));
    const invoice = issued.body as { invoiceId: string; payTo: string; memo: string };

    const { txid } = await h.pair.payer.send({
      to: invoice.payTo,
      amountZat: "40000",
      memo: invoice.memo,
    });
    h.pair.chain.mine(1);

    const response = await h.handle(
      request("POST", "/verify", { body: { invoiceId: invoice.invoiceId, txid } }),
    );
    expect(response.status).toBe(402);
    expect(response.body).toMatchObject({ reason: "underpaid", shortfallZat: "60000" });
  });

  it("rejects malformed request bodies", async () => {
    expect((await h.handle(request("POST", "/invoices", { body: {} }))).status).toBe(400);
    expect((await h.handle(request("POST", "/invoices", { body: { amountZat: 5 } }))).status).toBe(
      400,
    );
    expect((await h.handle(request("POST", "/invoices", { body: { amountZat: "0" } }))).status).toBe(
      400,
    );
    expect((await h.handle(request("POST", "/verify", { body: {} }))).status).toBe(400);
  });

  it("returns 404 for unknown routes", async () => {
    expect((await h.handle(request("GET", "/nope"))).status).toBe(404);
  });

  it("ignores a trailing slash", async () => {
    expect((await h.handle(request("GET", "/info/"))).status).toBe(200);
  });
});

describe("a facilitator that charges a fee", () => {
  /** Payee, payer and the facilitator's own fee wallet, on one shared chain. */
  function chargingHarness(fee = { bps: 100 }) {
    const pair = createMockPair(NETWORK_TESTNET);
    pair.fundPayer("1000000000");
    const feeWallet = new MockWallet({
      network: NETWORK_TESTNET,
      chain: pair.chain,
      addressPrefix: "utest1facil",
    });
    const store = new MemoryInvoiceStore();
    const facilitator = new ByteFacilitator({
      wallet: viewOnly(pair.payee),
      store,
      secret: SECRET,
      apiKey: API_KEY,
      fee: { ...fee, payTo: feeWallet.fundingAddress },
      feeWallet: viewOnly(feeWallet),
    });
    return { pair, feeWallet, store, facilitator };
  }

  it("publishes its terms, so a merchant sees them before delegating", () => {
    const h = chargingHarness({ bps: 150 });
    expect(h.facilitator.info().fee).toMatchObject({ bps: 150 });
  });

  it("publishes null when it charges nothing", () => {
    expect(harness().facilitator.info().fee).toBeNull();
  });

  it("issues invoices with the fee output and settles them through the real payer", async () => {
    // Through BytePayer, not hand-credited: the previous version of the fee tests did the
    // latter and proved the verifier while hiding that nothing could pay a fee invoice.
    const h = chargingHarness();
    const invoice = await h.facilitator.issue("10000000");
    expect(invoice.fee).toMatchObject({ amount: "100000", bps: 100 });

    const { txid } = await new BytePayer({ wallet: h.pair.payer }).pay(invoice, "https://x.test");
    h.pair.chain.mine(1);

    const result = await h.facilitator.verify({ invoiceId: invoice.invoiceId, txid });
    expect(result.ok).toBe(true);
  });

  it("refuses a payment that skipped the fee", async () => {
    const h = chargingHarness();
    const invoice = await h.facilitator.issue("10000000");

    const { txid } = await h.pair.payer.send({
      to: invoice.payTo,
      amountZat: invoice.amount,
      memo: invoice.memo,
    });
    h.pair.chain.mine(1);

    const result = await h.facilitator.verify({ invoiceId: invoice.invoiceId, txid });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("underpaid");
  });

  it("refuses to charge a fee it could not see arriving", () => {
    // A facilitator that charged without a wallet for its fee address would refuse
    // nothing and collect nothing, and learn of it only when revenue read zero.
    const pair = createMockPair(NETWORK_TESTNET);
    expect(
      () =>
        new ByteFacilitator({
          wallet: viewOnly(pair.payee),
          store: new MemoryInvoiceStore(),
          secret: SECRET,
          apiKey: API_KEY,
          fee: { bps: 100, payTo: "utest1facil" },
        }),
    ).toThrow(/needs a feeWallet/);
  });

  it("refuses a spending wallet as the fee wallet", () => {
    // The whole security argument for a facilitator is that compromising it cannot move
    // funds. A spendable feeWallet would quietly void that.
    const pair = createMockPair(NETWORK_TESTNET);
    expect(
      () =>
        new ByteFacilitator({
          wallet: viewOnly(pair.payee),
          store: new MemoryInvoiceStore(),
          secret: SECRET,
          apiKey: API_KEY,
          fee: { bps: 100, payTo: "utest1facil" },
          feeWallet: pair.payer,
        }),
    ).toThrow(/feeWallet must be view-only/);
  });

  it("refuses impossible terms at construction", () => {
    const pair = createMockPair(NETWORK_TESTNET);
    expect(
      () =>
        new ByteFacilitator({
          wallet: viewOnly(pair.payee),
          store: new MemoryInvoiceStore(),
          secret: SECRET,
          apiKey: API_KEY,
          fee: { bps: 50_000, payTo: "utest1facil" },
          feeWallet: viewOnly(pair.payee),
        }),
    ).toThrow(/over 100%/);
  });
});
