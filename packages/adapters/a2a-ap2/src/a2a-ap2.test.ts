import { beforeEach, describe, expect, it } from "vitest";
import { NETWORK_MAINNET, NETWORK_TESTNET, ByteProtocolError } from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import { SpendGuard } from "@byte-protocol/client";
import { createMockPair, viewOnly, type MockPair } from "@byte-protocol/wallet";
import {
  BYTE_PAYMENT_METHOD,
  CART_MANDATE_DATA_KEY,
  PAYMENT_MANDATE_DATA_KEY,
  byteInvoiceFromCart,
  dataPart,
  fromPaymentMandateData,
  fromPaymentMethodData,
  readDataPart,
  toPaymentMethodData,
  type Ap2CartMandate,
  type PaymentMethodData,
} from "./method.js";
import { ByteAp2Merchant, ByteAp2Payer } from "./flow.js";

const SECRET = new Uint8Array(32).fill(41);
const PRICE = "100000";
const MERCHANT_URL = "https://merchant.example.com/a2a";

interface Harness {
  pair: MockPair;
  store: MemoryInvoiceStore;
  merchant: ByteAp2Merchant;
}

function harness(): Harness {
  const pair = createMockPair(NETWORK_TESTNET);
  pair.fundPayer("100000000");
  const store = new MemoryInvoiceStore();
  const wallet = viewOnly(pair.payee);
  return {
    pair,
    store,
    merchant: new ByteAp2Merchant({
      issuer: new InvoiceIssuer({ wallet, store, secret: SECRET }),
      verifier: new PaymentVerifier({ wallet, store, secret: SECRET }),
    }),
  };
}

/** A cart offering the given methods, shaped like AP2's CartMandate. */
function cart(methods: PaymentMethodData[]): Ap2CartMandate {
  return {
    contents: {
      id: "cart-1",
      payment_request: { method_data: methods },
      cart_expiry: "2026-09-29T13:00:00Z",
    },
    merchant_authorization: null,
  };
}

describe("the Byte payment method", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("is identified by Byte's native scheme name", async () => {
    const { method } = await h.merchant.offer(PRICE);
    expect(method.supported_methods).toBe(BYTE_PAYMENT_METHOD);
    expect(method.supported_methods).toBe("byte-zcash-shielded-v1");
  });

  it("carries the network inside data, because a method identifier cannot", async () => {
    // AP2 identifies a method by a single string. That string has no room for a network,
    // and paying on the wrong one sends value somewhere unrecoverable.
    const { method } = await h.merchant.offer(PRICE);
    expect(method.data).toMatchObject({ network: NETWORK_TESTNET, asset: "ZEC" });
  });

  it("round-trips an invoice through the method data", async () => {
    const { method, invoice } = await h.merchant.offer(PRICE);
    expect(fromPaymentMethodData(method)).toMatchObject({
      network: invoice.network,
      amount: invoice.amount,
      payTo: invoice.payTo,
      invoiceId: invoice.invoiceId,
      memo: invoice.memo,
      zip321: invoice.zip321,
      minConfirmations: invoice.minConfirmations,
    });
  });

  it.each([
    ["a non-object", 42],
    ["a foreign method", { supported_methods: "basic-card" }],
    ["a Byte method with no data", { supported_methods: BYTE_PAYMENT_METHOD }],
  ])("refuses %s", (_label, value) => {
    expect(() => fromPaymentMethodData(value)).toThrow(ByteProtocolError);
  });

  it("refuses method data missing a required field", async () => {
    const { method } = await h.merchant.offer(PRICE);
    for (const field of ["amount", "payTo", "invoice_id", "memo", "zip321", "expires_at"]) {
      const { [field]: _dropped, ...rest } = method.data as Record<string, unknown>;
      expect(() => fromPaymentMethodData({ ...method, data: rest })).toThrow(
        new RegExp(field),
      );
    }
  });

  it("refuses an unknown network", async () => {
    const { method } = await h.merchant.offer(PRICE);
    expect(() =>
      fromPaymentMethodData({
        ...method,
        data: { ...(method.data as object), network: "eip155:8453" },
      }),
    ).toThrow(/not a Byte network/);
  });
});

describe("finding Byte in a cart", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("finds the Byte method among others", async () => {
    const { method, invoice } = await h.merchant.offer(PRICE);
    const found = byteInvoiceFromCart(
      cart([{ supported_methods: "basic-card" }, method, { supported_methods: "https://pay.example" }]),
    );
    expect(found?.invoiceId).toBe(invoice.invoiceId);
  });

  it("returns undefined when the merchant accepts no Byte method", () => {
    // So a client can fall back to another payment method rather than failing.
    expect(byteInvoiceFromCart(cart([{ supported_methods: "basic-card" }]))).toBeUndefined();
  });

  it("returns undefined for a malformed cart rather than throwing", () => {
    expect(byteInvoiceFromCart({ contents: {} } as unknown as Ap2CartMandate)).toBeUndefined();
  });
});

describe("A2A DataParts", () => {
  it("wraps and reads a value under an AP2 mandate key", () => {
    const part = dataPart(CART_MANDATE_DATA_KEY, { id: "cart-1" });
    expect(part.kind).toBe("data");
    expect(readDataPart([part], CART_MANDATE_DATA_KEY)).toEqual({ id: "cart-1" });
  });

  it("uses AP2's documented key strings", () => {
    expect(CART_MANDATE_DATA_KEY).toBe("ap2.mandates.CartMandate");
    expect(PAYMENT_MANDATE_DATA_KEY).toBe("ap2.mandates.PaymentMandate");
  });

  it("returns undefined for a missing key or a non-list", () => {
    expect(readDataPart([], CART_MANDATE_DATA_KEY)).toBeUndefined();
    expect(readDataPart(undefined, CART_MANDATE_DATA_KEY)).toBeUndefined();
  });
});

describe("the full AP2 flow", () => {
  let h: Harness;
  let payer: ByteAp2Payer;

  beforeEach(() => {
    h = harness();
    payer = new ByteAp2Payer({ wallet: h.pair.payer, merchantUrl: MERCHANT_URL });
  });

  it("pays a cart and the merchant verifies the mandate", async () => {
    const { method } = await h.merchant.offer(PRICE);
    const { mandateData, txid } = await payer.payCart(cart([method]));
    h.pair.chain.mine(1);

    const result = await h.merchant.settle(mandateData);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.txid).toBe(txid);
      expect(result.note.pool).toBe("ironwood");
    }
  });

  it("verifies a mandate carried inside A2A DataParts", async () => {
    const { method } = await h.merchant.offer(PRICE);
    const { mandateData } = await payer.payCart(cart([method]));
    h.pair.chain.mine(1);

    const parts = [dataPart(PAYMENT_MANDATE_DATA_KEY, mandateData)];
    expect((await h.merchant.settle(parts)).ok).toBe(true);
  });

  it("refuses a replayed mandate", async () => {
    const { method } = await h.merchant.offer(PRICE);
    const { mandateData } = await payer.payCart(cart([method]));
    h.pair.chain.mine(1);

    expect((await h.merchant.settle(mandateData)).ok).toBe(true);
    const replay = await h.merchant.settle(mandateData);
    expect(replay).toMatchObject({ ok: false, reason: "replay" });
  });

  it("throws when a cart offers no Byte method, and spends nothing", async () => {
    const before = (await h.pair.payer.balance()).spendableZat;
    await expect(payer.payCart(cart([{ supported_methods: "basic-card" }]))).rejects.toThrow(
      /does not accept the Byte payment method/,
    );
    expect((await h.pair.payer.balance()).spendableZat).toBe(before);
  });

  it("does not pay when the guard denies", async () => {
    const guarded = new ByteAp2Payer({
      wallet: h.pair.payer,
      merchantUrl: MERCHANT_URL,
      guard: new SpendGuard({ maxPerCallZat: "1" }),
    });
    const { method } = await h.merchant.offer(PRICE);
    await expect(guarded.payCart(cart([method]))).rejects.toThrow();
  });

  it("attributes the spend to the merchant URL in the audit log", async () => {
    const guard = new SpendGuard({ maxDailyZat: "10000000" });
    const audited = new ByteAp2Payer({
      wallet: h.pair.payer,
      merchantUrl: MERCHANT_URL,
      guard,
    });
    const { method } = await h.merchant.offer(PRICE);
    await audited.payCart(cart([method]));

    expect(guard.auditLog().at(-1)).toMatchObject({
      allowed: true,
      host: "merchant.example.com",
      amountZat: PRICE,
    });
  });

  it("refuses a cart whose Byte method is for another network, before spending", async () => {
    const before = (await h.pair.payer.balance()).spendableZat;
    const { method } = await h.merchant.offer(PRICE);
    const wrongNetwork: PaymentMethodData = {
      ...method,
      data: { ...(method.data as object), network: NETWORK_MAINNET },
    };

    await expect(payer.payCart(cart([wrongNetwork]))).rejects.toThrow(/but this wallet is on/);
    expect((await h.pair.payer.balance()).spendableZat).toBe(before);
  });
});

describe("payment mandate data", () => {
  it("refuses a mandate for a different payment method", () => {
    expect(() => fromPaymentMandateData({ supported_methods: "basic-card" })).toThrow(
      /not for the Byte payment method/,
    );
  });

  it("refuses a mandate with no claim", () => {
    expect(() =>
      fromPaymentMandateData({ supported_methods: BYTE_PAYMENT_METHOD, data: {} }),
    ).toThrow(/invoice_id and txid/);
  });
});
