import { describe, expect, it } from "vitest";
import { NETWORK_TESTNET, ByteProtocolError } from "@byte-protocol/core";
import { MockChain, MockWallet } from "@byte-protocol/wallet";
import { NearIntentsRail } from "./rail.js";
import type { RailQuote } from "@byte-protocol/rails";

const T_ADDR = "t1" + "a".repeat(33);
const DEPOSIT_T = "t1" + "b".repeat(33);
const REFUND_TO = "0x1111111111111111111111111111111111111111";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

/** A 1Click stand-in, shaped from the live responses in `fixtures/`. */
function mockApi(overrides: { quote?: unknown; status?: unknown; deposit?: unknown } = {}) {
  const calls: Array<{ url: string; method: string; body?: any }> = [];

  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });

    if (url.includes("/tokens")) {
      return Response.json([
        { assetId: "nep141:zec.omft.near", symbol: "ZEC", blockchain: "zec" },
      ]);
    }
    if (url.includes("/deposit/submit")) {
      return Response.json(overrides.deposit ?? { status: "KNOWN_DEPOSIT_TX" });
    }
    if (url.includes("/quote")) {
      return Response.json(
        overrides.quote ?? {
          quote: {
            depositAddress: DEPOSIT_T,
            amountIn: "10000000",
            amountOut: "139000000",
            deadline: "2026-09-30T02:00:00Z",
            withdrawFee: "32000",
            refundFee: "2400",
          },
          quoteRequest: { appFees: [{ recipient: "abc", fee: 20 }] },
        },
      );
    }
    if (url.includes("/status")) {
      return Response.json(
        overrides.status ?? { status: "SUCCESS", updatedAt: "2026-09-30T01:00:00Z" },
      );
    }
    return new Response("not found", { status: 404 });
  };

  return { fetch: fetchMock, calls };
}

function walletRail(options: { quote?: unknown; status?: unknown } = {}) {
  const chain = new MockChain();
  const wallet = new MockWallet({
    network: NETWORK_TESTNET,
    chain,
    addressPrefix: "utest1rail",
    sleep: async () => {},
  });
  const api = mockApi(options);
  const rail = new NearIntentsRail({
    network: NETWORK_TESTNET,
    wallet,
    refundTo: REFUND_TO,
    fetch: api.fetch,
  });
  return { chain, wallet, api, rail };
}

describe("confidentiality", () => {
  /**
   * The live service taught this, and the docs do not: **every confidential setting needs a
   * JWT.** Sending `basic` without one is refused with
   * `401 "User authentication is required for confidential intent quotes"`.
   *
   * So Byte sends `basic` when it can and `public` when it cannot, and says which. A rail
   * that asked for confidentiality regardless would fail every quote; one that silently got
   * `public` while the caller believed otherwise would be worse.
   */
  function railWith(options: Record<string, unknown>) {
    const api = mockApi();
    const rail = new NearIntentsRail({
      network: NETWORK_TESTNET,
      recipientTransparentAddress: T_ADDR,
      refundTo: REFUND_TO,
      fetch: api.fetch,
      ...options,
    });
    return { api, rail };
  }

  it("asks for basic when a JWT is configured", async () => {
    const h = railWith({ jwt: "a.jwt.token" });
    await h.rail.quote({ from: BASE_USDC, amountOutZat: "10000000" });
    expect(h.api.calls.find((c) => c.url.includes("/quote"))?.body.confidentiality).toBe("basic");
  });

  it("falls back to public without one, rather than failing every quote", async () => {
    const h = railWith({});
    await h.rail.quote({ from: BASE_USDC, amountOutZat: "10000000" });
    expect(h.api.calls.find((c) => c.url.includes("/quote"))?.body.confidentiality).toBe("public");
  });

  it("says out loud when it fell back", async () => {
    // Believing a quote is confidential when it is not is the outcome worth preventing.
    const h = railWith({});
    const quote = await h.rail.quote({ from: BASE_USDC, amountOutZat: "10000000" });
    expect(quote.fees?.note).toMatch(/confidentiality is 'public'.*need a 1Click JWT/s);
  });

  it("says nothing about a fallback when it did not fall back", async () => {
    const h = railWith({ jwt: "a.jwt.token" });
    const quote = await h.rail.quote({ from: BASE_USDC, amountOutZat: "10000000" });
    expect(quote.fees?.note).toBeUndefined();
  });

  it("never leaves the field unset, because the API's own default is the most revealing", async () => {
    const h = railWith({});
    await h.rail.quote({ from: BASE_USDC, amountOutZat: "10000000" });
    expect(h.api.calls.find((c) => c.url.includes("/quote"))?.body).toHaveProperty(
      "confidentiality",
    );
  });

  it("can be overridden", async () => {
    const api = mockApi();
    const rail = new NearIntentsRail({
      network: NETWORK_TESTNET,
      recipientTransparentAddress: T_ADDR,
      refundTo: REFUND_TO,
      confidentiality: "public",
      fetch: api.fetch,
    });
    await rail.quote({ from: BASE_USDC, amountOutZat: "10000000" });
    expect(api.calls.find((c) => c.url.includes("/quote"))?.body.confidentiality).toBe("public");
  });
});

describe("a fresh transparent address per funding", () => {
  it("mints a new one for every quote", async () => {
    // One fixed address would hand an observer every funding this rail ever performs,
    // tied together as one party's history.
    const h = walletRail();
    await h.rail.quote({ from: BASE_USDC, amountOutZat: "10000000" });
    await h.rail.quote({ from: BASE_USDC, amountOutZat: "20000000" });

    const recipients = h.api.calls
      .filter((c) => c.url.includes("/quote"))
      .map((c) => c.body.recipient);

    expect(recipients).toHaveLength(2);
    expect(recipients[0]).not.toBe(recipients[1]);
    expect(recipients[0]).toMatch(/^t1/);
  });

  it("still accepts a fixed address when there is no wallet", async () => {
    const api = mockApi();
    const rail = new NearIntentsRail({
      network: NETWORK_TESTNET,
      recipientTransparentAddress: T_ADDR,
      refundTo: REFUND_TO,
      fetch: api.fetch,
    });
    await rail.quote({ from: BASE_USDC, amountOutZat: "10000000" });
    expect(api.calls.find((c) => c.url.includes("/quote"))?.body.recipient).toBe(T_ADDR);
  });

  it("refuses to be built with neither a wallet nor an address", () => {
    expect(
      () => new NearIntentsRail({ network: NETWORK_TESTNET, refundTo: REFUND_TO }),
    ).toThrow(/either a wallet.*or a fixed/s);
  });
});

describe("the fee breakdown", () => {
  it("itemises NEAR's fees and never mixes them with Byte's", async () => {
    const h = walletRail();
    const quote = await h.rail.quote({ from: BASE_USDC, amountOutZat: "10000000" });

    expect(quote.fees?.items).toEqual([
      { label: "withdraw", amount: "32000" },
      { label: "refund", amount: "2400" },
    ]);
  });

  it("lists an appFee Byte never asked for separately", async () => {
    // 1Click attaches its own. A charge the caller did not request is the one they most
    // need to see, so it does not get folded into the total.
    const h = walletRail();
    const quote = await h.rail.quote({ from: BASE_USDC, amountOutZat: "10000000" });

    expect(quote.fees?.unrequested).toEqual([
      { label: "appFee to abc", amount: "20", asset: "bps" },
    ]);
  });

  it("notes the surcharge for calling without a JWT, as theirs and not Byte's", async () => {
    const h = walletRail();
    const quote = await h.rail.quote({ from: BASE_USDC, amountOutZat: "10000000" });
    expect(quote.fees?.note).toMatch(/0\.25%.*theirs, not Byte's/);
  });
});

describe("cashing out", () => {
  it("quotes ZEC in, another asset out, spending an exact input", async () => {
    // EXACT_INPUT, not EXACT_OUTPUT: the wallet has to commit to a specific amount leaving
    // the shielded pool, and an exact output would let that vary.
    const h = walletRail();
    await h.rail.cashOutQuote({ to: BASE_USDC, amountInZat: "10000000", recipient: "0xdest" });

    const body = h.api.calls.find((c) => c.url.includes("/quote"))?.body;
    expect(body).toMatchObject({
      swapType: "EXACT_INPUT",
      originAsset: "nep141:zec.omft.near",
      destinationAsset: BASE_USDC,
      amount: "10000000",
      recipient: "0xdest",
    });
  });

  it("refunds to a fresh transparent address the auto-shielder is watching", async () => {
    const h = walletRail();
    await h.rail.cashOutQuote({ to: BASE_USDC, amountInZat: "10000000", recipient: "0xdest" });

    const body = h.api.calls.find((c) => c.url.includes("/quote"))?.body;
    expect(body.refundTo).toMatch(/^t1/);
    expect(body.refundType).toBe("ORIGIN_CHAIN");
  });

  it("is dry by default", async () => {
    const h = walletRail();
    const quote = await h.rail.cashOutQuote({
      to: BASE_USDC,
      amountInZat: "10000000",
      recipient: "0xdest",
    });
    expect(quote.dry).toBe(true);
  });

  it("refuses a malformed amount or an empty recipient", async () => {
    const h = walletRail();
    await expect(
      h.rail.cashOutQuote({ to: BASE_USDC, amountInZat: "1.5", recipient: "0xdest" }),
    ).rejects.toThrow(ByteProtocolError);
    await expect(
      h.rail.cashOutQuote({ to: BASE_USDC, amountInZat: "10000000", recipient: "" }),
    ).rejects.toThrow(/recipient/);
  });
});

describe("paying a cash-out", () => {
  function live(overrides: Partial<RailQuote> = {}): RailQuote {
    return {
      railId: "near-intents",
      depositAddress: DEPOSIT_T,
      amountIn: "10000000",
      amountOutZat: "139000000",
      deadline: "2026-09-30T02:00:00Z",
      dry: false,
      transparentLeg: { public: true, reason: "test" },
      signatureVerified: true,
      ...overrides,
    };
  }

  it("unshields to the deposit address", async () => {
    const h = walletRail();
    h.chain.payInto({ payTo: h.wallet.fundingAddress, amountZat: "100000000" });
    h.chain.mine(1);

    const result = await h.rail.payCashOut(live());

    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    h.chain.mine(1);
    expect(h.chain.transparentAt(DEPOSIT_T)).toBe(10000000n);
  });

  it("refuses an unverified quote, because the deposit address is the field worth forging", async () => {
    const h = walletRail();
    await expect(h.rail.payCashOut(live({ signatureVerified: false }))).rejects.toThrow(
      /signature did not check out/,
    );
  });

  it("refuses a dry quote, which reserved no address", async () => {
    const h = walletRail();
    await expect(h.rail.payCashOut(live({ dry: true }))).rejects.toThrow(/dry quote/);
  });

  it("refuses a deposit address that is not a transparent Zcash address", async () => {
    // For a cash-out the deposit address is on the origin chain, which is Zcash. Anything
    // else means the response is not what this code thinks it is, and sending is final.
    const h = walletRail();
    await expect(
      h.rail.payCashOut(live({ depositAddress: "0xdeadbeef" })),
    ).rejects.toThrow(/not a\s+transparent Zcash address/);
  });

  it("refuses a quote requiring a memo, which a transparent output cannot carry", async () => {
    const h = walletRail();
    await expect(h.rail.payCashOut(live({ depositMemo: "12345" }))).rejects.toThrow(
      /cannot carry one/,
    );
  });

  it("refuses without a wallet that can spend", async () => {
    const api = mockApi();
    const rail = new NearIntentsRail({
      network: NETWORK_TESTNET,
      recipientTransparentAddress: T_ADDR,
      refundTo: REFUND_TO,
      fetch: api.fetch,
    });
    await expect(rail.payCashOut(live())).rejects.toThrow(/needs a wallet that can spend/);
  });
});

describe("submitting a deposit", () => {
  it("tells 1Click about the transaction and returns the mapped status", async () => {
    const h = walletRail();
    const status = await h.rail.submitDeposit({
      txHash: "0xabc",
      depositAddress: DEPOSIT_T,
    });

    expect(status.kind).toBe("deposit_seen");
    const call = h.api.calls.find((c) => c.url.includes("/deposit/submit"));
    expect(call?.body).toEqual({ txHash: "0xabc", depositAddress: DEPOSIT_T });
  });

  it("passes a memo through when one is required", async () => {
    const h = walletRail();
    await h.rail.submitDeposit({ txHash: "0xabc", depositAddress: DEPOSIT_T, depositMemo: "m" });
    expect(h.api.calls.find((c) => c.url.includes("/deposit/submit"))?.body.memo).toBe("m");
  });
});

describe("settling a funding", () => {
  it("shields the proceeds once the swap has delivered", async () => {
    // The rail delivers to a transparent address, so the funds sit in public until
    // something moves them, and Byte cannot spend them at all until they are in Ironwood.
    const h = walletRail();
    h.chain.payInto({
      payTo: h.wallet.transparentAddress,
      amountZat: "50000000",
      pool: "transparent",
    });
    h.chain.mine(1);

    const result = await h.rail.settle(DEPOSIT_T);

    expect(result.status.kind).toBe("delivered");
    expect(result.shieldedZat).toBe("49990000");
  });

  it("shields nothing while the swap is still running", async () => {
    const h = walletRail({ status: { status: "PROCESSING" } });
    const result = await h.rail.settle(DEPOSIT_T);

    expect(result.status.kind).toBe("processing");
    expect(result.shieldedZat).toBeUndefined();
  });

  it("does not treat a refund as a delivery", async () => {
    const h = walletRail({ status: { status: "REFUNDED" } });
    const result = await h.rail.settle(DEPOSIT_T);
    expect(result.status.kind).toBe("refunded");
    expect(result.shieldedZat).toBeUndefined();
  });
});
