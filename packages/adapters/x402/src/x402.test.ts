import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BYTE_SCHEME,
  NETWORK_MAINNET,
  NETWORK_TESTNET,
  ByteProtocolError,
  X402_VERSION,
} from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import { SpendGuard } from "@byte-protocol/client";
import { createMockPair, viewOnly, type MockPair } from "@byte-protocol/wallet";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  decodeHeader,
  encodeHeader,
  fromX402Payload,
  fromX402Requirements,
  toX402PaymentRequired,
  toX402Requirements,
} from "./mapping.js";
import { createX402Fetch, createX402Gate } from "./gate.js";

const SECRET = new Uint8Array(32).fill(23);
const PRICE = "100000";

async function invoiceFor(pair: MockPair) {
  const issuer = new InvoiceIssuer({
    wallet: viewOnly(pair.payee),
    store: new MemoryInvoiceStore(),
    secret: SECRET,
  });
  return issuer.issue(PRICE);
}

describe("mapping onto x402 v2", () => {
  let pair: MockPair;
  beforeEach(() => {
    pair = createMockPair(NETWORK_TESTNET);
  });

  it("maps to scheme exact with a Zcash network, not a bespoke scheme", async () => {
    // Byte's movement is ordinary 'pay exactly this to this address'. Inventing a parallel
    // scheme would make this a dialect of x402 rather than a contribution to it.
    const requirements = toX402Requirements(await invoiceFor(pair));
    expect(requirements.scheme).toBe("exact");
    expect(requirements.network).toBe(NETWORK_TESTNET);
    expect(requirements.asset).toBe("ZEC");
  });

  it("carries Byte specifics in extra", async () => {
    const invoice = await invoiceFor(pair);
    const requirements = toX402Requirements(invoice);
    expect(requirements.extra).toMatchObject({
      byteScheme: BYTE_SCHEME,
      invoiceId: invoice.invoiceId,
      memo: invoice.memo,
      zip321: invoice.zip321,
      minConfirmations: invoice.minConfirmations,
    });
  });

  it("derives maxTimeoutSeconds from the expiry and never goes negative", async () => {
    const invoice = await invoiceFor(pair);
    const expiry = Date.parse(invoice.expiresAt);
    expect(toX402Requirements(invoice, expiry - 60_000).maxTimeoutSeconds).toBe(60);
    expect(toX402Requirements(invoice, expiry + 60_000).maxTimeoutSeconds).toBe(0);
  });

  it("round-trips an invoice through the x402 envelope", async () => {
    const invoice = await invoiceFor(pair);
    const now = Date.parse(invoice.expiresAt) - 300_000;
    const recovered = fromX402Requirements(toX402Requirements(invoice, now), now);

    expect(recovered).toMatchObject({
      scheme: BYTE_SCHEME,
      network: invoice.network,
      amount: invoice.amount,
      payTo: invoice.payTo,
      invoiceId: invoice.invoiceId,
      memo: invoice.memo,
      zip321: invoice.zip321,
      minConfirmations: invoice.minConfirmations,
    });
  });

  it("wraps requirements in a PaymentRequired at version 2", async () => {
    const required = toX402PaymentRequired(await invoiceFor(pair));
    expect(required.x402Version).toBe(X402_VERSION);
    expect(required.accepts).toHaveLength(1);
  });

  it.each([
    ["a non-object", 42],
    ["a foreign scheme", { scheme: "deferred" }],
    ["an unknown network", { scheme: "exact", network: "eip155:8453" }],
    ["a non-ZEC asset", { scheme: "exact", network: NETWORK_TESTNET, asset: "USDC" }],
  ])("refuses %s", (_label, requirements) => {
    expect(() => fromX402Requirements(requirements)).toThrow(ByteProtocolError);
  });

  it("refuses x402 requirements that carry no Byte extra", async () => {
    // An `exact` payment on a Zcash network that Byte did not issue is not Byte-settled,
    // and paying it would produce a transaction nothing can verify.
    const invoice = await invoiceFor(pair);
    const { extra: _extra, ...withoutExtra } = toX402Requirements(invoice);
    expect(() => fromX402Requirements(withoutExtra)).toThrow(/no Byte extra/);
  });

  it("refuses a payload at the wrong protocol version", () => {
    expect(() =>
      fromX402Payload({ x402Version: 1, payload: { txid: "a", invoiceId: "b" } }),
    ).toThrow(/x402Version/);
  });

  it("round-trips headers and refuses malformed ones", () => {
    expect(decodeHeader(encodeHeader({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeHeader(null)).toBeUndefined();
    expect(decodeHeader("")).toBeUndefined();
    expect(() => decodeHeader("not base64 json!!")).toThrow(ByteProtocolError);
  });
});

describe("the x402 loop over HTTP", () => {
  let pair: MockPair;
  let store: MemoryInvoiceStore;
  let server: ReturnType<typeof createServer>;
  let origin: string;
  let served = 0;

  beforeEach(async () => {
    pair = createMockPair(NETWORK_TESTNET);
    pair.fundPayer("100000000");
    store = new MemoryInvoiceStore();
    served = 0;

    const wallet = viewOnly(pair.payee);
    const gate = createX402Gate({
      issuer: new InvoiceIssuer({ wallet, store, secret: SECRET }),
      verifier: new PaymentVerifier({ wallet, store, secret: SECRET }),
      priceZat: PRICE,
    });

    server = createServer((req, res) => {
      void (async () => {
        const result = await gate({
          header: (name) => (req.headers[name] as string | undefined) ?? null,
        });
        if (!result.paid) {
          res.writeHead(result.response.status, result.response.headers);
          res.end(JSON.stringify(result.response.body));
          return;
        }
        served += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ secret: "paid resource", txid: result.txid }));
      })();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    origin = `http://127.0.0.1:${address.port}`;

    // Mine as soon as the payer broadcasts, so the retry finds a confirmed payment.
    const send = pair.payer.send.bind(pair.payer);
    vi.spyOn(pair.payer, "send").mockImplementation(async (request) => {
      const result = await send(request);
      pair.chain.mine(1);
      return result;
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  it("pays an x402 402 and is served", async () => {
    const pay = createX402Fetch({ wallet: pair.payer });
    const response = await pay(`${origin}/premium`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ secret: "paid resource" });
    expect(served).toBe(1);
  });

  it("sends the requirements in the PAYMENT-REQUIRED header", async () => {
    const unpaid = await globalThis.fetch(`${origin}/premium`);
    expect(unpaid.status).toBe(402);

    const required = decodeHeader(unpaid.headers.get(PAYMENT_REQUIRED_HEADER)) as {
      x402Version: number;
      accepts: unknown[];
    };
    expect(required.x402Version).toBe(X402_VERSION);
    expect(required.accepts).toHaveLength(1);
  });

  it("returns the payload in the PAYMENT-SIGNATURE header", async () => {
    const seen: string[] = [];
    const pay = createX402Fetch({
      wallet: pair.payer,
      fetch: async (input, init) => {
        const header = new Headers(init?.headers).get(PAYMENT_SIGNATURE_HEADER);
        if (header !== null) seen.push(header);
        return globalThis.fetch(input as string, init);
      },
    });

    await pay(`${origin}/premium`);
    expect(seen).toHaveLength(1);
    const payload = decodeHeader(seen[0]) as { payload: { txid: string } };
    expect(payload.payload.txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a replay as 409", async () => {
    const seen: string[] = [];
    const pay = createX402Fetch({
      wallet: pair.payer,
      fetch: async (input, init) => {
        const header = new Headers(init?.headers).get(PAYMENT_SIGNATURE_HEADER);
        if (header !== null) seen.push(header);
        return globalThis.fetch(input as string, init);
      },
    });
    await pay(`${origin}/premium`);

    const replay = await globalThis.fetch(`${origin}/premium`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: seen[0] as string },
    });
    expect(replay.status).toBe(409);
    expect(served).toBe(1);
  });

  it("does not pay when the guard denies", async () => {
    const guard = new SpendGuard({ maxPerCallZat: "1" });
    const pay = createX402Fetch({ wallet: pair.payer, guard });
    await expect(pay(`${origin}/premium`)).rejects.toThrow();
    expect(served).toBe(0);
  });

  it("refuses an invoice for the wrong network before spending", async () => {
    const before = (await pair.payer.balance()).spendableZat;
    const wrongNetwork = createServer((_req, res) => {
      void (async () => {
        const invoice = await invoiceFor(pair);
        const required = toX402PaymentRequired({ ...invoice, network: NETWORK_MAINNET });
        res.writeHead(402, {
          "content-type": "application/json",
          [PAYMENT_REQUIRED_HEADER]: encodeHeader(required),
        });
        res.end(JSON.stringify(required));
      })();
    });
    await new Promise<void>((resolve) => wrongNetwork.listen(0, "127.0.0.1", resolve));
    const address = wrongNetwork.address();
    if (address === null || typeof address === "string") throw new Error("no address");

    const pay = createX402Fetch({ wallet: pair.payer });
    await expect(pay(`http://127.0.0.1:${address.port}/x`)).rejects.toThrow();
    expect((await pair.payer.balance()).spendableZat).toBe(before);

    await new Promise<void>((resolve) => wrongNetwork.close(() => resolve()));
  });
});
