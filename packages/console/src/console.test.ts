import { beforeEach, describe, expect, it } from "vitest";
import { NETWORK_TESTNET, newInvoiceId } from "@byte-protocol/core";
import type { StoredInvoice } from "@byte-protocol/core";
import { MemoryInvoiceStore, MemoryReceiptStore } from "@byte-protocol/stores";
import { SpendGuard } from "@byte-protocol/client";
import { createMockPair, viewOnly } from "@byte-protocol/wallet";
import { createConsoleApi, type ConsoleRequest } from "./api.js";
import { consoleHtml } from "./ui.js";
import { startConsole } from "./server.js";

const TOKEN = "t".repeat(32);

function invoice(overrides: Partial<StoredInvoice> = {}): StoredInvoice {
  return {
    invoiceId: newInvoiceId(),
    network: NETWORK_TESTNET,
    amountZat: "100000",
    payTo: "utest1example",
    memo: "BYTE1|x|y",
    minConfirmations: 1,
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    ...overrides,
  };
}

function harness(options: { guard?: SpendGuard } = {}) {
  const pair = createMockPair(NETWORK_TESTNET);
  const invoices = new MemoryInvoiceStore();
  const receipts = new MemoryReceiptStore();
  const handle = createConsoleApi({
    wallet: viewOnly(pair.payee),
    invoices,
    receipts,
    token: TOKEN,
    label: "demo node",
    ...(options.guard !== undefined ? { guard: options.guard } : {}),
  });
  return { pair, invoices, receipts, handle };
}

function request(
  method: string,
  path: string,
  options: { token?: string | null; query?: Record<string, string> } = {},
): ConsoleRequest {
  const token = options.token === undefined ? TOKEN : options.token;
  return {
    method,
    path,
    ...(options.query !== undefined ? { query: options.query } : {}),
    header: (name) =>
      name.toLowerCase() === "authorization" && token !== null ? `Bearer ${token}` : null,
  };
}

describe("authorization", () => {
  it("has no unauthenticated route, not even a health check", async () => {
    // Even "this node exists and is healthy" is information about the node.
    const h = harness();
    for (const path of ["/", "/overview", "/invoices", "/balance", "/guard", "/receipts"]) {
      expect((await h.handle(request("GET", path, { token: null }))).status).toBe(401);
    }
  });

  it("rejects a token that is close but wrong", async () => {
    const h = harness();
    for (const bad of [TOKEN + "x", TOKEN.slice(0, -1), "", "Bearer"]) {
      expect((await h.handle(request("GET", "/overview", { token: bad }))).status).toBe(401);
    }
  });

  it("refuses to start with a short token", () => {
    const pair = createMockPair(NETWORK_TESTNET);
    expect(() =>
      createConsoleApi({
        wallet: viewOnly(pair.payee),
        invoices: new MemoryInvoiceStore(),
        token: "short",
      }),
    ).toThrow(/at least 32/);
  });
});

describe("overview", () => {
  it("counts invoices by state", async () => {
    const h = harness();
    await h.invoices.put(invoice());
    await h.invoices.put(invoice({ expiresAt: Date.now() - 1 }));
    const paid = invoice();
    await h.invoices.put(paid);
    await h.invoices.consume(paid.invoiceId, "a".repeat(64));

    const body = (await h.handle(request("GET", "/overview"))).body as {
      invoices: Record<string, number>;
      settledZat: string;
    };

    expect(body.invoices).toMatchObject({
      total: 3,
      consumed: 1,
      outstanding: 1,
      expired: 1,
    });
    expect(body.settledZat).toBe("100000");
  });

  it("reports a null balance rather than zeroes when the wallet cannot answer", async () => {
    // A zero balance from an unsynced wallet is indistinguishable from an empty one.
    const pair = createMockPair(NETWORK_TESTNET);
    const wallet = viewOnly(pair.payee);
    const handle = createConsoleApi({
      wallet: {
        ...wallet,
        balance: async () => {
          throw new Error("not synced");
        },
      },
      invoices: new MemoryInvoiceStore(),
      token: TOKEN,
    });

    const body = (await handle(request("GET", "/overview"))).body as { balance: unknown };
    expect(body.balance).toBeNull();
  });

  it("reports the guard when one is configured, and null when not", async () => {
    const guard = new SpendGuard({ maxPerCallZat: "1000" });
    await guard.authorize({ amountZat: "500", url: "https://ok.example.com/x" });
    await guard.authorize({ amountZat: "9999", url: "https://ok.example.com/x" });

    const withGuard = harness({ guard });
    const body = (await withGuard.handle(request("GET", "/overview"))).body as {
      guard: { spentTodayZat: string; decisions: number; refusals: number };
    };
    expect(body.guard).toMatchObject({ spentTodayZat: "500", decisions: 2, refusals: 1 });

    const without = harness();
    expect(
      ((await without.handle(request("GET", "/overview"))).body as { guard: unknown }).guard,
    ).toBeNull();
  });
});

describe("invoices", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    for (let n = 0; n < 5; n++) await h.invoices.put(invoice({ createdAt: n }));
  });

  it("lists them and clamps an absurd limit", async () => {
    const body = (await h.handle(request("GET", "/invoices"))).body as { invoices: unknown[] };
    expect(body.invoices).toHaveLength(5);

    const clamped = (await h.handle(request("GET", "/invoices", { query: { limit: "99999" } })))
      .body as { invoices: unknown[] };
    expect(clamped.invoices.length).toBeLessThanOrEqual(200);
  });

  it("filters by status", async () => {
    const paid = invoice();
    await h.invoices.put(paid);
    await h.invoices.consume(paid.invoiceId, "b".repeat(64));

    const body = (
      await h.handle(request("GET", "/invoices", { query: { status: "consumed" } }))
    ).body as { invoices: unknown[] };
    expect(body.invoices).toHaveLength(1);
  });

  it("fetches one by id and 404s on an unknown one", async () => {
    const { invoices } = await h.invoices.list();
    const id = invoices[0]!.invoiceId;
    expect((await h.handle(request("GET", `/invoices/${id}`))).status).toBe(200);
    expect((await h.handle(request("GET", "/invoices/nope"))).status).toBe(404);
  });
});

describe("guard and receipts", () => {
  it("404s when a guard is not configured", async () => {
    expect((await harness().handle(request("GET", "/guard"))).status).toBe(404);
  });

  it("returns guard entries newest first, refusals included", async () => {
    // An operator needs to see why a payment was stopped, not only that it was.
    const guard = new SpendGuard({ allow: ["ok.example.com"] });
    await guard.authorize({ amountZat: "1", url: "https://ok.example.com/a" });
    await guard.authorize({ amountZat: "2", url: "https://blocked.example.com/b" });

    const body = (await harness({ guard }).handle(request("GET", "/guard"))).body as {
      entries: Array<{ allowed: boolean; reason?: string }>;
    };
    expect(body.entries[0]).toMatchObject({ allowed: false, reason: "host_not_allowed" });
    expect(body.entries[1]).toMatchObject({ allowed: true });
  });

  it("serves receipts when configured", async () => {
    const h = harness();
    expect((await h.handle(request("GET", "/receipts"))).status).toBe(200);
  });
});

describe("the console page", () => {
  it("loads nothing from anywhere else", () => {
    // A page reporting on a privacy protocol must not fetch scripts from third parties who
    // would then see every operator who opens it.
    const html = consoleHtml();
    expect(html).not.toMatch(/https?:\/\/(?!localhost|127\.0\.0\.1)/);
    expect(html).not.toContain("<script src");
    expect(html).not.toContain("<link rel=\"stylesheet\"");
  });

  it("renders nothing before the token is accepted", () => {
    const html = consoleHtml();
    expect(html).toContain('id="app" hidden');
    expect(html).toContain('id="gate"');
  });

  it("says plainly what it exposes", () => {
    expect(consoleHtml()).toMatch(/owner-only/i);
  });
});

describe("the console server", () => {
  it("serves the page and gates the API", async () => {
    const h = harness();
    const running = await startConsole({
      wallet: viewOnly(h.pair.payee),
      invoices: h.invoices,
      token: TOKEN,
      label: "demo node",
    });

    try {
      const page = await fetch(running.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      // Owner-only data must not sit in a shared cache.
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");

      expect((await fetch(`${running.url}/api/overview`)).status).toBe(401);

      const authorized = await fetch(`${running.url}/api/overview`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(authorized.status).toBe(200);
      expect(((await authorized.json()) as { label: string }).label).toBe("demo node");

      expect((await fetch(`${running.url}/nope`)).status).toBe(404);
    } finally {
      await running.close();
    }
  });

  it("binds to loopback by default", async () => {
    const h = harness();
    const running = await startConsole({
      wallet: viewOnly(h.pair.payee),
      invoices: h.invoices,
      token: TOKEN,
    });
    try {
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    } finally {
      await running.close();
    }
  });
});
