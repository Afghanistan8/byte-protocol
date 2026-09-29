import { describe, expect, it } from "vitest";
import { NETWORK_TESTNET, ByteProtocolError, parseZip321Multi } from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { MockChain, MockWallet } from "@byte-protocol/wallet";
import { InvoiceIssuer } from "./issuer.js";
import { PaymentVerifier } from "./verifier.js";

const SECRET = new Uint8Array(32).fill(11);

/**
 * A payee, a payer, and a facilitator with its own wallet.
 *
 * Three wallets rather than two, because the fee genuinely goes somewhere else: the payee's
 * viewing key cannot see the facilitator's fee output, and pretending one wallet could see
 * both would test a configuration nobody can deploy.
 */
function harness(options: { bps?: number; minZat?: string } = {}) {
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

  const store = new MemoryInvoiceStore();
  const issuer = new InvoiceIssuer({
    wallet: payee,
    store,
    secret: SECRET,
    ...(options.bps !== undefined
      ? {
          facilitatorFee: {
            bps: options.bps,
            payTo: facilitator.fundingAddress,
            ...(options.minZat !== undefined ? { minZat: options.minZat } : {}),
          },
        }
      : {}),
  });
  const verifier = new PaymentVerifier({
    wallet: payee,
    store,
    secret: SECRET,
    feeWallet: facilitator,
  });

  return { chain, payee, payer, facilitator, store, issuer, verifier };
}

describe("no fee by default", () => {
  it("issues a single-output invoice with no fee block", async () => {
    const h = harness();
    const invoice = await h.issuer.issue("10000000");

    expect(invoice.fee).toBeUndefined();
    expect(parseZip321Multi(invoice.zip321)).toHaveLength(1);
  });

  it("omits the second output when the terms come to zero", async () => {
    // A zero-value output would cost the payer a ZIP 317 action fee for something nobody
    // can spend.
    const h = harness({ bps: 0 });
    const invoice = await h.issuer.issue("10000000");

    expect(invoice.fee).toBeUndefined();
    expect(parseZip321Multi(invoice.zip321)).toHaveLength(1);
  });
});

describe("a facilitator fee", () => {
  it("adds a second output to the ZIP-321 request", async () => {
    const h = harness({ bps: 100 });
    const invoice = await h.issuer.issue("10000000");

    expect(invoice.fee).toEqual({
      amount: "100000",
      payTo: h.facilitator.fundingAddress,
      bps: 100,
    });

    const payments = parseZip321Multi(invoice.zip321);
    expect(payments).toHaveLength(2);
    expect(payments[0]).toMatchObject({ address: invoice.payTo, amountZat: "10000000" });
    expect(payments[1]).toMatchObject({
      address: h.facilitator.fundingAddress,
      amountZat: "100000",
    });
  });

  it("leaves the payee's amount alone", async () => {
    // The fee is a separate output. A payee's accounting should never have to subtract
    // someone else's fee out of its own revenue.
    const h = harness({ bps: 250 });
    const invoice = await h.issuer.issue("10000000");
    expect(invoice.amount).toBe("10000000");
  });

  it("puts no memo on the fee leg", async () => {
    // The fee output binds to no invoice, and a memo on it would be a second place an
    // invoice identifier could leak to a third party.
    const h = harness({ bps: 100 });
    const invoice = await h.issuer.issue("10000000");
    const payments = parseZip321Multi(invoice.zip321);

    expect(payments[0]?.memo).toBeDefined();
    expect(payments[1]?.memo).toBeUndefined();
  });

  it("refuses impossible terms at construction, not on a live invoice", async () => {
    const h = harness();
    expect(
      () =>
        new InvoiceIssuer({
          wallet: h.payee,
          store: h.store,
          secret: SECRET,
          facilitatorFee: { bps: 20_000, payTo: "utest1x" },
        }),
    ).toThrow(ByteProtocolError);
  });
});

describe("verifying a fee", () => {
  /** Pay both legs of the request, as a well-behaved payer does. */
  async function payBoth(h: ReturnType<typeof harness>, invoice: Awaited<ReturnType<InvoiceIssuer["issue"]>>) {
    const { txid } = await h.payer.send({
      to: invoice.payTo,
      amountZat: invoice.amount,
      memo: invoice.memo,
    });
    // The mock builds one transaction per send, so the fee leg is credited into the same
    // transaction to model the atomicity a real two-output transaction has.
    h.chain.payInto({
      payTo: invoice.fee?.payTo ?? "",
      amountZat: invoice.fee?.amount ?? "0",
      txid,
    });
    h.chain.mine(1);
    return txid;
  }

  it("accepts a payment that settled both outputs", async () => {
    const h = harness({ bps: 100 });
    const invoice = await h.issuer.issue("10000000");
    const txid = await payBoth(h, invoice);

    const result = await h.verifier.verify(invoice.invoiceId, txid);
    expect(result.ok).toBe(true);
  });

  it("refuses a payment that settled the payee but skipped the fee", async () => {
    // This is the case the whole design rests on. Nothing on-chain requires the second
    // output; the facilitator's check is the only thing that does.
    const h = harness({ bps: 100 });
    const invoice = await h.issuer.issue("10000000");

    const { txid } = await h.payer.send({
      to: invoice.payTo,
      amountZat: invoice.amount,
      memo: invoice.memo,
    });
    h.chain.mine(1);

    const result = await h.verifier.verify(invoice.invoiceId, txid);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("underpaid");
    expect(result.shortfallZat).toBe("100000");
  });

  it("leaves the invoice open when only the fee was missed", async () => {
    // Refusing must not burn the invoice: the payer can still pay correctly, and an
    // invoice consumed by a failed verification would strand their money.
    const h = harness({ bps: 100 });
    const invoice = await h.issuer.issue("10000000");

    const { txid } = await h.payer.send({
      to: invoice.payTo,
      amountZat: invoice.amount,
      memo: invoice.memo,
    });
    h.chain.mine(1);
    await h.verifier.verify(invoice.invoiceId, txid);

    const stored = await h.store.get(invoice.invoiceId);
    expect(stored?.consumedAt).toBeUndefined();
  });

  it("accepts a fee that was overpaid", async () => {
    const h = harness({ bps: 100 });
    const invoice = await h.issuer.issue("10000000");

    const { txid } = await h.payer.send({
      to: invoice.payTo,
      amountZat: invoice.amount,
      memo: invoice.memo,
    });
    h.chain.payInto({ payTo: h.facilitator.fundingAddress, amountZat: "200000", txid });
    h.chain.mine(1);

    expect((await h.verifier.verify(invoice.invoiceId, txid)).ok).toBe(true);
  });

  it("refuses rather than passing when it cannot see the fee address", async () => {
    // A facilitator misconfigured without a viewing key for its own fee address must not
    // discover it by silently collecting nothing.
    const h = harness({ bps: 100 });
    const blind = new PaymentVerifier({ wallet: h.payee, store: h.store, secret: SECRET });

    const invoice = await h.issuer.issue("10000000");
    const txid = await payBoth(h, invoice);

    const result = await blind.verify(invoice.invoiceId, txid);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/no viewing key for the fee address/);
  });

  it("ignores a fee paid in the wrong pool", async () => {
    // Value that arrived outside Ironwood is not value Byte will treat as settled, for the
    // fee leg exactly as for the payee's.
    const h = harness({ bps: 100 });
    const invoice = await h.issuer.issue("10000000");

    const { txid } = await h.payer.send({
      to: invoice.payTo,
      amountZat: invoice.amount,
      memo: invoice.memo,
    });
    h.chain.payInto({
      payTo: h.facilitator.fundingAddress,
      amountZat: "100000",
      pool: "transparent",
      txid,
    });
    h.chain.mine(1);

    const result = await h.verifier.verify(invoice.invoiceId, txid);
    expect(result.ok).toBe(false);
  });
});
