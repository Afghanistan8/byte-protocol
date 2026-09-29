import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NETWORK_TESTNET,
  NU6_3_BRANCH_ID_HEX,
  NU7_BRANCH_ID_HEX,
  ByteProtocolError,
  encodeMemo,
  parsePaymentRequirements,
  parseZip321,
} from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { MockChain, MockWallet, createMockPair, viewOnly } from "@byte-protocol/wallet";
import type { MockPair } from "@byte-protocol/wallet";
import { InvoiceIssuer } from "./issuer.js";
import { PaymentVerifier } from "./verifier.js";

const SECRET = new Uint8Array(32).fill(11);
const OTHER_SECRET = new Uint8Array(32).fill(22);

interface Harness {
  pair: MockPair;
  store: MemoryInvoiceStore;
  issuer: InvoiceIssuer;
  verifier: PaymentVerifier;
  now: () => number;
  setNow: (t: number) => void;
}

function harness(options: { minConfirmations?: number; ttlMs?: number } = {}): Harness {
  const pair = createMockPair(NETWORK_TESTNET);
  const store = new MemoryInvoiceStore();
  let clock = 1_000_000;
  const now = () => clock;

  const wallet = viewOnly(pair.payee);
  const issuer = new InvoiceIssuer({
    wallet,
    store,
    secret: SECRET,
    now,
    ...(options.minConfirmations !== undefined
      ? { minConfirmations: options.minConfirmations }
      : {}),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
  });
  const verifier = new PaymentVerifier({ wallet, store, secret: SECRET, now });

  pair.fundPayer("100000000");
  return { pair, store, issuer, verifier, now, setNow: (t) => (clock = t) };
}

/** Pay an invoice exactly as a well-behaved client would, and mine it. */
async function pay(
  h: Harness,
  invoice: { payTo: string; amount: string; memo: string },
  overrides: { amountZat?: string; memo?: string; confirmations?: number } = {},
): Promise<string> {
  const { txid } = await h.pair.payer.send({
    to: invoice.payTo,
    amountZat: overrides.amountZat ?? invoice.amount,
    memo: overrides.memo ?? invoice.memo,
  });
  h.pair.chain.mine(overrides.confirmations ?? 1);
  return txid;
}

describe("InvoiceIssuer", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("issues requirements that validate against the schema", async () => {
    const invoice = await h.issuer.issue("100000");
    expect(() => parsePaymentRequirements(invoice)).not.toThrow();
    expect(invoice.scheme).toBe("byte-zcash-shielded-v1");
    expect(invoice.asset).toBe("ZEC");
    expect(invoice.amount).toBe("100000");
  });

  it("mints a fresh address for every invoice", async () => {
    // Two invoices sharing an address would be linkable on-chain.
    const addresses = new Set<string>();
    for (let n = 0; n < 50; n++) addresses.add((await h.issuer.issue("1000")).payTo);
    expect(addresses.size).toBe(50);
  });

  it("records the invoice before returning it", async () => {
    // Otherwise a payer could hold an invoice the payee has no record of.
    const invoice = await h.issuer.issue("100000");
    expect(await h.store.get(invoice.invoiceId)).toBeDefined();
  });

  it("emits a ZIP-321 URI encoding the same payment", async () => {
    const invoice = await h.issuer.issue("250000");
    const parsed = parseZip321(invoice.zip321);
    expect(parsed.address).toBe(invoice.payTo);
    expect(parsed.amountZat).toBe("250000");
    expect(parsed.memo).toBe(invoice.memo);
  });

  it("sets an expiry from the configured ttl", async () => {
    const withTtl = harness({ ttlMs: 60_000 });
    const invoice = await withTtl.issuer.issue("1000");
    expect(Date.parse(invoice.expiresAt)).toBe(withTtl.now() + 60_000);
  });

  it("rejects a malformed or zero amount", async () => {
    for (const bad of ["", "0", "-1", "1.5", "abc", "01"]) {
      await expect(h.issuer.issue(bad)).rejects.toThrow(ByteProtocolError);
    }
  });

  it("refuses to start with a short secret or nonsensical settings", () => {
    const wallet = viewOnly(h.pair.payee);
    const store = new MemoryInvoiceStore();
    expect(() => new InvoiceIssuer({ wallet, store, secret: new Uint8Array(31) })).toThrow();
    expect(
      () => new InvoiceIssuer({ wallet, store, secret: SECRET, ttlMs: 0 }),
    ).toThrow();
    expect(
      () => new InvoiceIssuer({ wallet, store, secret: SECRET, minConfirmations: -1 }),
    ).toThrow();
  });
});

describe("PaymentVerifier — the happy path", () => {
  it("accepts a correctly paid invoice and consumes it", async () => {
    const h = harness();
    const invoice = await h.issuer.issue("100000");
    const txid = await pay(h, invoice);

    const result = await h.verifier.verify(invoice.invoiceId, txid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.note.pool).toBe("ironwood");
    expect(result.note.valueZat).toBe("100000");
    expect(result.txid).toBe(txid);
    expect(result.invoice.consumedAt).toBeDefined();
  });

  it("accepts an overpayment and keeps the surplus", async () => {
    // Refunding would mean sending value back to a payer Byte deliberately cannot
    // identify. Documented in SPEC section 8 and SECURITY section 5.2.
    const h = harness();
    const invoice = await h.issuer.issue("100000");
    const txid = await pay(h, invoice, { amountZat: "150000" });

    const result = await h.verifier.verify(invoice.invoiceId, txid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.note.valueZat).toBe("150000");
  });
});

describe("PaymentVerifier — every documented failure", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("reports underpaid with the shortfall", async () => {
    const invoice = await h.issuer.issue("100000");
    const txid = await pay(h, invoice, { amountZat: "40000" });

    const result = await h.verifier.verify(invoice.invoiceId, txid);
    expect(result).toMatchObject({ ok: false, reason: "underpaid", shortfallZat: "60000" });
  });

  it("reports expired once the deadline passes", async () => {
    const invoice = await h.issuer.issue("100000");
    const txid = await pay(h, invoice);
    h.setNow(h.now() + 10 * 60 * 1000);

    const result = await h.verifier.verify(invoice.invoiceId, txid);
    expect(result).toMatchObject({ ok: false, reason: "expired" });
  });

  it("reports pending when the transaction has not been seen", async () => {
    const invoice = await h.issuer.issue("100000");
    const result = await h.verifier.verify(invoice.invoiceId, "f".repeat(64));
    expect(result).toMatchObject({ ok: false, reason: "pending" });
    if (!result.ok) expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("reports pending when there are too few confirmations", async () => {
    const strict = harness({ minConfirmations: 3 });
    const invoice = await strict.issuer.issue("100000");
    const txid = await pay(strict, invoice, { confirmations: 1 });

    const first = await strict.verifier.verify(invoice.invoiceId, txid);
    expect(first).toMatchObject({ ok: false, reason: "pending" });

    strict.pair.chain.mine(2);
    const second = await strict.verifier.verify(invoice.invoiceId, txid);
    expect(second.ok).toBe(true);
  });

  it("reports replay on a second claim", async () => {
    const invoice = await h.issuer.issue("100000");
    const txid = await pay(h, invoice);

    expect((await h.verifier.verify(invoice.invoiceId, txid)).ok).toBe(true);
    expect(await h.verifier.verify(invoice.invoiceId, txid)).toMatchObject({
      ok: false,
      reason: "replay",
    });
  });

  it("lets exactly one of many concurrent claims win", async () => {
    // The replay defence under contention, through the whole verifier rather than the
    // store alone.
    const invoice = await h.issuer.issue("100000");
    const txid = await pay(h, invoice);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => h.verifier.verify(invoice.invoiceId, txid)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("reports invalid_payment for a payment in the wrong pool", async () => {
    const invoice = await h.issuer.issue("100000");
    // Same amount, same memo, wrong pool. Only the pool differs.
    const txid = h.pair.chain.payInto({
      payTo: invoice.payTo,
      amountZat: "100000",
      memo: invoice.memo,
      pool: "orchard",
    });
    h.pair.chain.mine(1);

    const result = await h.verifier.verify(invoice.invoiceId, txid);
    expect(result).toMatchObject({ ok: false, reason: "invalid_payment" });
    if (!result.ok) expect(result.message).toContain("orchard");
  });

  it("reports invalid_payment for a payment carrying no memo", async () => {
    const invoice = await h.issuer.issue("100000");
    const txid = h.pair.chain.payInto({ payTo: invoice.payTo, amountZat: "100000" });
    h.pair.chain.mine(1);

    const result = await h.verifier.verify(invoice.invoiceId, txid);
    expect(result).toMatchObject({ ok: false, reason: "invalid_payment" });
    if (!result.ok) expect(result.message).toContain("no memo");
  });

  it("rejects a memo minted under a different secret", async () => {
    // A third party who can see an invoice must not be able to mint a memo this verifier
    // would accept.
    const invoice = await h.issuer.issue("100000");
    const forged = encodeMemo(OTHER_SECRET, {
      invoiceId: invoice.invoiceId,
      amountZat: invoice.amount,
      payTo: invoice.payTo,
    });
    const txid = await pay(h, invoice, { memo: forged });

    expect(await h.verifier.verify(invoice.invoiceId, txid)).toMatchObject({
      ok: false,
      reason: "invalid_payment",
    });
  });

  it("rejects a memo from one invoice presented against another", async () => {
    const a = await h.issuer.issue("100000");
    const b = await h.issuer.issue("100000");
    const txid = await pay(h, { ...b, memo: a.memo });

    expect(await h.verifier.verify(b.invoiceId, txid)).toMatchObject({
      ok: false,
      reason: "invalid_payment",
    });
  });

  it("reports invalid_payment for an unknown invoice", async () => {
    expect(await h.verifier.verify("0".repeat(32), "a".repeat(64))).toMatchObject({
      ok: false,
      reason: "invalid_payment",
    });
  });

  it("reports pending after a reorg drops the paying transaction", async () => {
    // Serving at zero confirmations means this can happen after delivery. The verifier's
    // job is to stop reporting success once the payment is gone.
    const invoice = await h.issuer.issue("100000");
    const txid = await pay(h, invoice);
    h.pair.chain.drop(txid);

    expect(await h.verifier.verify(invoice.invoiceId, txid)).toMatchObject({
      ok: false,
      reason: "pending",
    });
  });
});

describe("the verifier does not leak", () => {
  it("does not consume an invoice that failed verification", async () => {
    const h = harness();
    const invoice = await h.issuer.issue("100000");
    const txid = await pay(h, invoice, { amountZat: "1" });

    expect((await h.verifier.verify(invoice.invoiceId, txid)).ok).toBe(false);
    // The invoice must remain payable: an underpayment is not a spent invoice.
    expect((await h.store.get(invoice.invoiceId))?.consumedAt).toBeUndefined();

    const topUp = await pay(h, invoice);
    expect((await h.verifier.verify(invoice.invoiceId, topUp)).ok).toBe(true);
  });

  it("checks cheap local conditions before touching the wallet", async () => {
    // A flood of replayed or expired claims must not be usable to hammer the chain data
    // source. Verified by counting wallet calls.
    const h = harness();
    const invoice = await h.issuer.issue("100000");
    const txid = await pay(h, invoice);
    await h.verifier.verify(invoice.invoiceId, txid);

    let calls = 0;
    const counting = new PaymentVerifier({
      wallet: {
        network: h.pair.payee.network,
        newInvoiceAddress: () => h.pair.payee.newInvoiceAddress(),
        findOutputs: async (t) => {
          calls += 1;
          return h.pair.payee.findOutputs(t);
        },
        status: () => h.pair.payee.status(),
        balance: () => h.pair.payee.balance(),
      },
      store: h.store,
      secret: SECRET,
      now: h.now,
    });

    await counting.verify(invoice.invoiceId, txid);
    expect(calls).toBe(0);
  });
});

describe("USD-priced invoices", () => {
  /** A price source with no network behind it, fixed so the arithmetic is checkable. */
  function priceSource(price: number, source = "test") {
    return {
      sourceId: source,
      getZecUsd: async () => ({ price, source, at: Date.now(), timestamped: true }),
    };
  }

  function usdIssuer(price: number) {
    const { payee } = createMockPair(NETWORK_TESTNET);
    const store = new MemoryInvoiceStore();
    const issuer = new InvoiceIssuer({
      wallet: payee,
      store,
      secret: SECRET,
      priceSource: priceSource(price),
    });
    return { issuer, store, payee };
  }

  it("converts USD to zatoshis and locks the quote into the invoice", async () => {
    const { issuer } = usdIssuer(200);
    const requirements = await issuer.issueUsd("2.00");

    // $2 at $200/ZEC is 0.01 ZEC.
    expect(requirements.amount).toBe("1000000");
    expect(requirements.price).toMatchObject({
      priceUsd: "2.00",
      zecUsd: 200,
      priceSource: "test",
    });
    expect(requirements.price?.quotedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stores the quote, so a dispute can point at the rate actually used", async () => {
    const { issuer, store } = usdIssuer(200);
    const requirements = await issuer.issueUsd("2.00");

    const stored = await store.get(requirements.invoiceId);
    expect(stored?.price?.zecUsd).toBe(200);
  });

  it("is verified against the locked amount, never re-priced", async () => {
    // The whole point of locking. The payer builds a transaction for one amount; if the
    // payee re-priced while it confirmed, a correct payment would become "underpaid" for a
    // transaction that can no longer be changed.
    const pair = createMockPair(NETWORK_TESTNET);
    const { payee, payer, chain } = pair;
    pair.fundPayer("100000000");
    const store = new MemoryInvoiceStore();
    const secret = SECRET;

    let rate = 200;
    const issuer = new InvoiceIssuer({
      wallet: payee,
      store,
      secret,
      priceSource: {
        sourceId: "moving",
        getZecUsd: async () => ({
          price: rate,
          source: "moving",
          at: Date.now(),
          timestamped: true,
        }),
      },
    });
    const verifier = new PaymentVerifier({ wallet: payee, store, secret });

    const requirements = await issuer.issueUsd("2.00");
    const { txid } = await payer.send({
      to: requirements.payTo,
      amountZat: requirements.amount,
      memo: requirements.memo,
    });
    chain.mine(1);

    // The market moves hard between issue and settlement.
    rate = 20;

    const result = await verifier.verify(requirements.invoiceId, txid);
    expect(result.ok).toBe(true);
  });

  it("refuses a malformed price rather than coercing it", async () => {
    const { issuer } = usdIssuer(200);
    for (const bad of ["1.234", "-1", "1e2", "", "abc"]) {
      await expect(issuer.issueUsd(bad), bad).rejects.toThrow(ByteProtocolError);
    }
  });

  it("refuses to issue when the price source refuses", async () => {
    // A stale or contradicted price must not become an invoice. An attacker who can freeze
    // a feed could otherwise buy at yesterday's rate indefinitely.
    const { payee } = createMockPair(NETWORK_TESTNET);
    const issuer = new InvoiceIssuer({
      wallet: payee,
      store: new MemoryInvoiceStore(),
      secret: SECRET,
      priceSource: {
        sourceId: "broken",
        getZecUsd: async () => {
          throw new Error("price feed is stale");
        },
      },
    });

    await expect(issuer.issueUsd("2.00")).rejects.toThrow(/stale/);
  });

  it("refuses issueUsd with no price source at all", async () => {
    const { payee } = createMockPair(NETWORK_TESTNET);
    const issuer = new InvoiceIssuer({
      wallet: payee,
      store: new MemoryInvoiceStore(),
      secret: SECRET,
    });

    await expect(issuer.issueUsd("2.00")).rejects.toThrow(/no safe default/);
  });

  it("leaves a plain zatoshi invoice without a price block", async () => {
    const { issuer } = usdIssuer(200);
    const requirements = await issuer.issue("1000000");
    expect(requirements.price).toBeUndefined();
  });
});

describe("Retry-After follows the chain's consensus branch", () => {
  /**
   * The defect this guards against.
   *
   * Spacing used to be chosen by height, against a published *estimate* of 4,386,000 for
   * NU7 on testnet. Byte's own testnet run was mined at 4,413,018 — above the estimate —
   * so a pending payment on testnet was already being told to retry in 25 seconds while
   * the chain was still producing a block every 75. Three times too short, weeks before
   * NU7 activates.
   */
  const TESTNET_HEIGHT_TODAY = 4_414_380;

  function harnessOn(branchId: string) {
    const chain = new MockChain();
    const payee = new MockWallet({
      network: NETWORK_TESTNET,
      chain,
      addressPrefix: "utest1payee",
      consensusBranchId: branchId,
    });
    const store = new MemoryInvoiceStore();
    return {
      chain,
      store,
      issuer: new InvoiceIssuer({ wallet: payee, store, secret: SECRET }),
      verifier: new PaymentVerifier({ wallet: payee, store, secret: SECRET }),
    };
  }

  it("says 75 seconds at today's testnet height, because the branch is still Ironwood", async () => {
    const h = harnessOn(NU6_3_BRANCH_ID_HEX);
    h.chain.mine(TESTNET_HEIGHT_TODAY - h.chain.height);

    const invoice = await h.issuer.issue("100000");
    const result = await h.verifier.verify(invoice.invoiceId, "ab".repeat(32));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("pending");
    expect(result.retryAfterSeconds).toBe(75);
  });

  it("says 25 seconds once the chain reports the NU7 branch", async () => {
    const h = harnessOn(NU7_BRANCH_ID_HEX);

    const invoice = await h.issuer.issue("100000");
    const result = await h.verifier.verify(invoice.invoiceId, "ab".repeat(32));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.retryAfterSeconds).toBe(25);
  });

  it("says 75 seconds when the chain has not reported a branch at all", async () => {
    const chain = new MockChain();
    const payee = new MockWallet({ network: NETWORK_TESTNET, chain });
    // A wallet that cannot say which branch it is on gets the slower, safer answer.
    vi.spyOn(payee, "status").mockResolvedValue({
      network: NETWORK_TESTNET,
      syncedHeight: TESTNET_HEIGHT_TODAY,
      chainTip: TESTNET_HEIGHT_TODAY,
      synced: true,
    });

    const store = new MemoryInvoiceStore();
    const issuer = new InvoiceIssuer({ wallet: payee, store, secret: SECRET });
    const verifier = new PaymentVerifier({ wallet: payee, store, secret: SECRET });

    const invoice = await issuer.issue("100000");
    const result = await verifier.verify(invoice.invoiceId, "ab".repeat(32));

    if (result.ok) throw new Error("unreachable");
    expect(result.retryAfterSeconds).toBe(75);
  });
});
