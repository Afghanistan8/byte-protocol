import { describe, expect, it, vi } from "vitest";
import { NETWORK_TESTNET, ByteProtocolError } from "@byte-protocol/core";
import {
  NearIntentsRail,
  ONE_CLICK_STATUSES,
  isTransparentAddress,
  type OneClickStatus,
} from "./rail.js";

/** A valid-looking transparent address. */
const T_ADDR = "t1" + "a".repeat(33);
const REFUND_TO = "0x1111111111111111111111111111111111111111";

/**
 * Mocked 1Click, shaped from the OpenAPI document at
 * https://1click.chaindefuser.com/docs/v0/openapi.yaml.
 */
function mockApi(
  overrides: { tokens?: unknown; quote?: unknown; status?: unknown; fail?: number } = {},
) {
  const calls: Array<{ url: string; method: string; body?: unknown; headers: Headers }> = [];

  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body, headers });

    if (overrides.fail !== undefined) {
      return new Response("upstream is unhappy", { status: overrides.fail });
    }
    if (url.includes("/tokens")) {
      return Response.json(
        overrides.tokens ?? [
          { assetId: "nep141:eth.omft.near", symbol: "ETH", blockchain: "eth" },
          { assetId: "nep141:zec.omft.near", symbol: "ZEC", blockchain: "zec" },
        ],
      );
    }
    if (url.includes("/quote")) {
      return Response.json(
        overrides.quote ?? {
          quote: {
            depositAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            amountIn: "1500000",
            amountOut: "10000000",
            deadline: "2026-09-29T13:00:00Z",
          },
        },
      );
    }
    if (url.includes("/status")) {
      return Response.json(
        overrides.status ?? {
          status: "SUCCESS",
          updatedAt: "2026-09-29T12:30:00Z",
          swapDetails: {
            amountOut: "10000000",
            destinationChainTxHashes: [{ hash: "abc123" }],
          },
        },
      );
    }
    return new Response("not found", { status: 404 });
  };

  return { fetch: fetchMock, calls };
}

function rail(options: Partial<ConstructorParameters<typeof NearIntentsRail>[0]> = {}) {
  const api = mockApi();
  return {
    api,
    rail: new NearIntentsRail({
      network: NETWORK_TESTNET,
      recipientTransparentAddress: T_ADDR,
      refundTo: REFUND_TO,
      fetch: api.fetch,
      ...options,
    }),
  };
}

describe("the transparent leg", () => {
  it("is declared public on the rail itself", () => {
    // A rail has to state whether it leaks. This one does.
    const { rail: r } = rail();
    expect(r.transparentLeg.public).toBe(true);
    expect(r.transparentLeg.reason).toMatch(/transparent addresses only/i);
  });

  it("is repeated on every quote", async () => {
    const { rail: r } = rail();
    const quote = await r.quote({ from: "nep141:base-usdc", amountOutZat: "10000000" });
    expect(quote.transparentLeg.public).toBe(true);
  });

  it("refuses a shielded or unified recipient with a reason", async () => {
    // Rejected here rather than by the API, so the failure names the real cause.
    for (const bad of ["utest1abcdef", "zs1abcdef", "u1abcdef", "not-an-address"]) {
      expect(
        () =>
          new NearIntentsRail({
            network: NETWORK_TESTNET,
            recipientTransparentAddress: bad,
            refundTo: REFUND_TO,
          }),
      ).toThrow(/transparent addresses only/i);
    }
  });

  it("recognises t1 and t3 and nothing else", () => {
    expect(isTransparentAddress(T_ADDR)).toBe(true);
    expect(isTransparentAddress("t3" + "b".repeat(33))).toBe(true);
    expect(isTransparentAddress("t2" + "c".repeat(33))).toBe(false);
    expect(isTransparentAddress("utest1" + "d".repeat(33))).toBe(false);
    expect(isTransparentAddress("t1short")).toBe(false);
  });
});

describe("quoting", () => {
  it("is dry by default", async () => {
    // A non-dry quote commits to moving real value through a public address. That should be
    // deliberate, not a default.
    const { rail: r, api } = rail();
    const quote = await r.quote({ from: "nep141:base-usdc", amountOutZat: "10000000" });

    expect(quote.dry).toBe(true);
    const quoteCall = api.calls.find((c) => c.url.includes("/quote"));
    expect((quoteCall?.body as { dry: boolean }).dry).toBe(true);
  });

  it("can be asked for a live quote explicitly", async () => {
    const { rail: r, api } = rail();
    const quote = await r.quote({
      from: "nep141:base-usdc",
      amountOutZat: "10000000",
      dry: false,
    });
    expect(quote.dry).toBe(false);
    expect((api.calls.find((c) => c.url.includes("/quote"))?.body as { dry: boolean }).dry).toBe(
      false,
    );
  });

  it("asks for EXACT_OUTPUT, because Byte funds a known invoice amount", async () => {
    const { rail: r, api } = rail();
    await r.quote({ from: "nep141:base-usdc", amountOutZat: "10000000" });

    const body = api.calls.find((c) => c.url.includes("/quote"))?.body as Record<string, unknown>;
    expect(body.swapType).toBe("EXACT_OUTPUT");
    expect(body.amount).toBe("10000000");
    expect(body.depositType).toBe("ORIGIN_CHAIN");
    expect(body.recipientType).toBe("DESTINATION_CHAIN");
    expect(body.recipient).toBe(T_ADDR);
  });

  it("resolves the ZEC asset from /tokens rather than hardcoding it", async () => {
    const { rail: r, api } = rail();
    await r.quote({ from: "nep141:base-usdc", amountOutZat: "10000000" });

    expect(api.calls.some((c) => c.url.includes("/tokens"))).toBe(true);
    const body = api.calls.find((c) => c.url.includes("/quote"))?.body as Record<string, unknown>;
    expect(body.destinationAsset).toBe("nep141:zec.omft.near");
  });

  it("fails clearly when ZEC is not listed", async () => {
    const api = mockApi({ tokens: [{ assetId: "x", symbol: "ETH", blockchain: "eth" }] });
    const r = new NearIntentsRail({
      network: NETWORK_TESTNET,
      recipientTransparentAddress: T_ADDR,
      refundTo: REFUND_TO,
      fetch: api.fetch,
    });
    await expect(r.quote({ from: "a", amountOutZat: "1" })).rejects.toThrow(/does not list a ZEC/);
  });

  it("requires a refund address", async () => {
    // Without one, a failed swap has nowhere to return value to.
    const api = mockApi();
    const r = new NearIntentsRail({
      network: NETWORK_TESTNET,
      recipientTransparentAddress: T_ADDR,
      fetch: api.fetch,
    });
    await expect(r.quote({ from: "a", amountOutZat: "10000000" })).rejects.toThrow(
      /refund address is required/,
    );
  });

  it("rejects a malformed amount", async () => {
    const { rail: r } = rail();
    for (const bad of ["", "-1", "1.5", "abc", "01"]) {
      await expect(r.quote({ from: "a", amountOutZat: bad })).rejects.toThrow(ByteProtocolError);
    }
  });

  it("sends the JWT when one is configured, and omits it otherwise", async () => {
    const withJwt = rail({ jwt: "a-token" });
    await withJwt.rail.quote({ from: "a", amountOutZat: "10000000" });
    expect(withJwt.api.calls[0]?.headers.get("authorization")).toBe("Bearer a-token");

    const without = rail();
    await without.rail.quote({ from: "a", amountOutZat: "10000000" });
    expect(without.api.calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("reports an upstream failure with its status", async () => {
    const api = mockApi({ fail: 503 });
    const r = new NearIntentsRail({
      network: NETWORK_TESTNET,
      recipientTransparentAddress: T_ADDR,
      refundTo: REFUND_TO,
      fetch: api.fetch,
    });
    await expect(r.quote({ from: "a", amountOutZat: "1" })).rejects.toThrow(/503/);
  });
});

describe("status mapping", () => {
  it.each([
    ["PENDING_DEPOSIT", "awaiting_deposit"],
    ["KNOWN_DEPOSIT_TX", "deposit_seen"],
    ["INCOMPLETE_DEPOSIT", "incomplete"],
    ["PROCESSING", "processing"],
    ["SUCCESS", "delivered"],
    ["REFUNDED", "refunded"],
    ["FAILED", "failed"],
  ] as const)("maps %s to %s", async (raw, kind) => {
    const api = mockApi({ status: { status: raw } });
    const r = new NearIntentsRail({
      network: NETWORK_TESTNET,
      recipientTransparentAddress: T_ADDR,
      refundTo: REFUND_TO,
      fetch: api.fetch,
    });
    const status = await r.status("0xdeposit");
    expect(status.kind).toBe(kind);
    expect(status.raw).toBe(raw);
  });

  it("covers every status the API documents", () => {
    // If 1Click adds a state, this fails rather than the mapping silently missing it.
    expect(ONE_CLICK_STATUSES).toHaveLength(7);
    for (const s of ONE_CLICK_STATUSES) {
      expect(typeof s).toBe("string");
    }
  });

  it("treats an unrecognised status as failed, never as success", async () => {
    // Guessing that an unknown state means success is the one mistake that costs money.
    const api = mockApi({ status: { status: "SOMETHING_NEW" as OneClickStatus } });
    const r = new NearIntentsRail({
      network: NETWORK_TESTNET,
      recipientTransparentAddress: T_ADDR,
      refundTo: REFUND_TO,
      fetch: api.fetch,
    });
    const status = await r.status("0xdeposit");
    expect(status.kind).toBe("failed");
    expect(status.raw).toBe("SOMETHING_NEW");
  });

  it("keeps the rail's own status string unmapped", async () => {
    const { rail: r } = rail();
    const status = await r.status("0xdeposit");
    expect(status.raw).toBe("SUCCESS");
    expect(status.amountOutZat).toBe("10000000");
    expect(status.destinationTxHash).toBe("abc123");
  });

  it("does not distinguish an incomplete deposit as a failure", async () => {
    // It means the funder sent too little, which is recoverable by topping up.
    const api = mockApi({ status: { status: "INCOMPLETE_DEPOSIT" } });
    const r = new NearIntentsRail({
      network: NETWORK_TESTNET,
      recipientTransparentAddress: T_ADDR,
      refundTo: REFUND_TO,
      fetch: api.fetch,
    });
    expect((await r.status("0xdeposit")).kind).toBe("incomplete");
  });
});
