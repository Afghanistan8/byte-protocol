import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BytePayerError, ByteProtocolError, NETWORK_TESTNET } from "@byte-protocol/core";
import { WalletdWallet, connectWalletd } from "./walletd.js";
import { canSpend } from "./wallet.js";

const TOKEN = "test-token-0123456789";

/**
 * A stand-in for byte-walletd, shaped from its real responses.
 *
 * Every body here was copied from a live run of the sidecar, so a change to its API breaks
 * this suite rather than surfacing later as a payment that silently does nothing.
 */
function fakeWalletd(overrides: Record<string, { status?: number; body: unknown }> = {}) {
  const requests: Array<{ method: string; path: string; auth: string | null; body?: unknown }> =
    [];

  const defaults: Record<string, { status?: number; body: unknown }> = {
    "GET /health": {
      body: { ok: true, version: "0.1.0", network: NETWORK_TESTNET, canSpend: true },
    },
    "GET /status": {
      body: {
        network: NETWORK_TESTNET,
        syncedHeight: 4413005,
        chainTip: 4413005,
        synced: true,
        nu63ActivationHeight: 4134000,
      },
    },
    "POST /addresses": {
      body: { address: "utest1xghzan2ngrekdl2pw3cfnu8cnkucmvez", diversifierIndex: 0 },
    },
    "GET /viewing-key": { body: { ufvk: "uviewtest1qvtryhkavsvn98" } },
    "GET /balance": {
      body: { spendableZat: "9990000", pendingZat: "0", unusableZat: "0" },
    },
    "GET /notes": {
      body: [
        {
          txid: "15a1ded9e252cfff784aae08add4a79b52424fc91bd304d96bcf41322e768369",
          pool: "ironwood",
          valueZat: "1000000",
          memo: "BYTE1|a4f23e7556fc9566f78673c8ebc52d3d|e62bbedfa6163d6a036aed7c0be475f2",
          confirmations: 6,
          height: 4413018,
        },
        {
          txid: "15a1ded9e252cfff784aae08add4a79b52424fc91bd304d96bcf41322e768369",
          pool: "ironwood",
          valueZat: "8990000",
          confirmations: 6,
          height: 4413018,
        },
      ],
    },
    "POST /send": {
      body: {
        txid: "15a1ded9e252cfff784aae08add4a79b52424fc91bd304d96bcf41322e768369",
        feeZat: "10000",
      },
    },
  };

  const routes = { ...defaults, ...overrides };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const key = `${req.method} ${url.pathname}`;
      const auth = req.headers.authorization ?? null;

      let body: unknown;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        body = raw === "" ? undefined : JSON.parse(raw);
      }
      requests.push({ method: req.method ?? "", path: url.pathname, auth, ...(body !== undefined ? { body } : {}) });

      // /health is the sidecar's only unauthenticated route.
      if (url.pathname !== "/health" && auth !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "unauthorized", message: "missing or invalid token" }));
        return;
      }

      const route = routes[key];
      if (route === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "not_found" }));
        return;
      }

      res.writeHead(route.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(route.body));
    })();
  });

  return {
    requests,
    start: async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      return `http://127.0.0.1:${address.port}`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let running: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function connect(
  overrides?: Record<string, { status?: number; body: unknown }>,
  options: { random?: () => number } = {},
) {
  const fake = fakeWalletd(overrides);
  running = fake;
  const url = await fake.start();
  const slept: number[] = [];
  const wallet = await WalletdWallet.connect({
    url,
    token: TOKEN,
    // Shielding deliberately delays. A suite that actually waited would be unusable.
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...(options.random !== undefined ? { random: options.random } : {}),
  });
  return { fake, wallet, slept };
}

describe("connecting", () => {
  it("reads the network from the sidecar rather than taking it as configuration", async () => {
    // A wallet configured for one network and pointed at a sidecar on another would send
    // real value somewhere unrecoverable.
    const { wallet } = await connect();
    expect(wallet.network).toBe(NETWORK_TESTNET);
  });

  it("refuses a sidecar reporting a network Byte does not recognise", async () => {
    const fake = fakeWalletd({
      "GET /health": { body: { ok: true, network: "eip155:8453", canSpend: true } },
    });
    running = fake;
    const url = await fake.start();
    await expect(WalletdWallet.connect({ url, token: TOKEN })).rejects.toThrow(
      /does not recognise/,
    );
  });

  it("reports a clear error when the sidecar is not running", async () => {
    await expect(
      WalletdWallet.connect({ url: "http://127.0.0.1:1", token: TOKEN }),
    ).rejects.toThrow(/Is it running\?/);
  });
});

describe("authentication", () => {
  it("sends the bearer token on every authenticated route", async () => {
    const { fake, wallet } = await connect();
    await wallet.newInvoiceAddress();
    await wallet.balance();

    const authenticated = fake.requests.filter((r) => r.path !== "/health");
    expect(authenticated.length).toBeGreaterThan(0);
    for (const request of authenticated) {
      expect(request.auth).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("surfaces a rejected token rather than returning empty data", async () => {
    const fake = fakeWalletd();
    running = fake;
    const url = await fake.start();
    const wallet = await WalletdWallet.connect({ url, token: "wrong-token" });
    await expect(wallet.balance()).rejects.toThrow(/401/);
  });
});

describe("reading the chain", () => {
  it("maps notes, keeping the pool and omitting payTo", async () => {
    // The sidecar cannot report an output's destination address, so the field is absent
    // rather than guessed. The verifier establishes it through the memo binding.
    const { wallet } = await connect();
    const notes = await wallet.findOutputs("15a1ded9" + "0".repeat(56));

    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({
      pool: "ironwood",
      valueZat: "1000000",
      confirmations: 6,
      height: 4413018,
    });
    expect(notes[0]?.payTo).toBeUndefined();
    // The change output carries no memo, which is correct: it is a payment to self.
    expect(notes[1]?.memo).toBeUndefined();
  });

  it("rejects a malformed note rather than passing it on", async () => {
    const { wallet } = await connect({
      "GET /notes": { body: [{ txid: "abc", pool: "ironwood" }] },
    });
    await expect(wallet.findOutputs("a".repeat(64))).rejects.toThrow(/malformed note/);
  });

  it("rejects a note list that is not a list", async () => {
    const { wallet } = await connect({ "GET /notes": { body: { nope: true } } });
    await expect(wallet.findOutputs("a".repeat(64))).rejects.toThrow(/malformed note list/);
  });

  it("reports status and balance", async () => {
    const { wallet } = await connect();
    expect(await wallet.status()).toMatchObject({ syncedHeight: 4413005, synced: true });
    expect(await wallet.balance()).toMatchObject({ spendableZat: "9990000" });
  });

  it("surfaces not_synced rather than inventing zeroes", async () => {
    // A zero balance from an unsynced wallet is indistinguishable from an empty one.
    const { wallet } = await connect({
      "GET /balance": {
        status: 503,
        body: { code: "not_synced", message: "wallet is not synced" },
      },
    });
    await expect(wallet.balance()).rejects.toThrow(/not_synced/);
  });
});

describe("sending", () => {
  it("returns the txid and fee, and sends the memo", async () => {
    const { fake, wallet } = await connect();
    const result = await wallet.send({
      to: "utest1destination",
      amountZat: "1000000",
      memo: "BYTE1|abc|def",
    });

    expect(result).toMatchObject({ txid: expect.stringMatching(/^[0-9a-f]{64}$/), feeZat: "10000" });

    // Always the `outputs` form on the wire, even for one output: one shape means one code
    // path in the sidecar, and the flat form is a caller convenience rather than a second
    // protocol.
    const sent = fake.requests.find((r) => r.path === "/send");
    expect(sent?.body).toEqual({
      outputs: [{ to: "utest1destination", amountZat: "1000000", memo: "BYTE1|abc|def" }],
    });
  });

  it("sends several outputs as one transaction", async () => {
    // A payment and its facilitator fee are atomic because they share a transaction. Two
    // broadcasts could not give that, and the verifier's 'both arrived' check rests on it.
    const { fake, wallet } = await connect();
    await wallet.send({
      outputs: [
        { to: "utest1payee", amountZat: "1000000", memo: "BYTE1|abc|def" },
        { to: "utest1facilitator", amountZat: "10000" },
      ],
    });

    const sent = fake.requests.find((r) => r.path === "/send");
    expect(sent?.body).toEqual({
      outputs: [
        { to: "utest1payee", amountZat: "1000000", memo: "BYTE1|abc|def" },
        // No memo on the fee leg: it binds to no invoice, and a memo there would be a
        // second place an invoice identifier could reach a third party.
        { to: "utest1facilitator", amountZat: "10000" },
      ],
    });
  });

  it("refuses a payment with no outputs at all", async () => {
    const { fake, wallet } = await connect();
    await expect(wallet.send({ outputs: [] })).rejects.toThrow(/at least one output/);
    expect(fake.requests.filter((r) => r.path === "/send")).toHaveLength(0);
  });

  it("raises wrong_pool_source as a payer refusal, not a transport error", async () => {
    // So the spend guard can refund and the caller can branch on `reason`, exactly as with
    // the mock.
    const { wallet } = await connect({
      "POST /send": {
        status: 502,
        body: {
          code: "wrong_pool_source",
          message: "funds sit in a pool Byte will not spend from",
        },
      },
    });

    const error = await wallet
      .send({ to: "utest1x", amountZat: "1", memo: "m" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BytePayerError);
    expect((error as BytePayerError).reason).toBe("wrong_pool_source");
  });

  it("raises insufficient_funds as a payer refusal", async () => {
    const { wallet } = await connect({
      "POST /send": {
        status: 502,
        body: { code: "insufficient_funds", message: "not enough spendable value" },
      },
    });
    const error = await wallet
      .send({ to: "utest1x", amountZat: "1", memo: "m" })
      .catch((e: unknown) => e);
    expect((error as BytePayerError).reason).toBe("insufficient_funds");
  });

  it("raises view_only as a protocol error, because it is a misconfiguration", async () => {
    // A view-only deployment asked to spend is not a payment that was refused on its merits;
    // it is a node wired up wrongly.
    const { wallet } = await connect({
      "POST /send": {
        status: 403,
        body: { code: "view_only", message: "this wallet holds no spending key" },
      },
    });
    await expect(wallet.send({ to: "utest1x", amountZat: "1", memo: "m" })).rejects.toThrow(
      ByteProtocolError,
    );
  });
});

describe("the view-only split survives HTTP", () => {
  it("returns a spending wallet when the sidecar holds a key", async () => {
    const fake = fakeWalletd();
    running = fake;
    const url = await fake.start();
    const wallet = await connectWalletd({ url, token: TOKEN });
    expect(canSpend(wallet)).toBe(true);
  });

  it("returns a wallet with no send when the sidecar is view-only", async () => {
    // A facilitator pointed at a view-only sidecar must not receive spend capability, and
    // the guarantee should hold at runtime, not only for the compiler.
    const fake = fakeWalletd({
      "GET /health": { body: { ok: true, network: NETWORK_TESTNET, canSpend: false } },
    });
    running = fake;
    const url = await fake.start();

    const wallet = await connectWalletd({ url, token: TOKEN });
    expect(canSpend(wallet)).toBe(false);
    expect((wallet as Record<string, unknown>).send).toBeUndefined();

    // It can still do everything a payee needs.
    expect(await wallet.newInvoiceAddress()).toMatch(/^utest1/);
    expect((await wallet.status()).synced).toBe(true);
  });
});

describe("shield", () => {
  const SHIELD_OK = {
    body: {
      txid: "aa1ded9e252cfff784aae08add4a79b52424fc91bd304d96bcf41322e7683690",
      amountZat: "4990000",
      feeZat: "10000",
    },
  };

  it("sweeps in one transaction by default", async () => {
    const { wallet, fake } = await connect({ "POST /shield": SHIELD_OK });
    const result = await wallet.shield();

    expect(result.transactions).toHaveLength(1);
    expect(result.shieldedZat).toBe("4990000");
    expect(result.feeZat).toBe("10000");

    // No addresses named means "every one you control", so the body carries none.
    const call = fake.requests.find((r) => r.path === "/shield");
    expect((call?.body as { fromTransparent?: string[] }).fromTransparent).toBeUndefined();
  });

  it("splits across the transparent addresses it was given", async () => {
    // byte-walletd selects inputs by address, so a split is several calls over different
    // addresses. Round-robin, not contiguous slices: addresses arrive in deposit order,
    // and contiguous slices would put consecutive deposits in the same transaction.
    const { wallet, fake } = await connect({ "POST /shield": SHIELD_OK });
    const addresses = ["t1a", "t1b", "t1c", "t1d", "t1e"];
    await wallet.shield({ splitInto: 2, fromTransparent: addresses });

    const groups = fake.requests
      .filter((r) => r.path === "/shield")
      .map((r) => (r.body as { fromTransparent: string[] }).fromTransparent);

    expect(groups).toEqual([
      ["t1a", "t1c", "t1e"],
      ["t1b", "t1d"],
    ]);
  });

  it("refuses a split it cannot actually perform", async () => {
    // A caller who asked for correlation resistance and silently got one transaction is
    // worse off than one who got an error: they think they have a property they do not.
    const { wallet, fake } = await connect({ "POST /shield": SHIELD_OK });

    await expect(wallet.shield({ splitInto: 3 })).rejects.toThrow(
      /needs at least 3 transparent addresses/,
    );
    await expect(
      wallet.shield({ splitInto: 3, fromTransparent: ["t1a", "t1b"] }),
    ).rejects.toThrow(/and 2 were given/);

    expect(fake.requests.filter((r) => r.path === "/shield")).toHaveLength(0);
  });

  it("waits a drawn delay between transactions", async () => {
    const { wallet, slept } = await connect({ "POST /shield": SHIELD_OK }, { random: () => 0.5 });
    const result = await wallet.shield({
      splitInto: 2,
      fromTransparent: ["t1a", "t1b"],
      delayRangeSec: [10, 20],
    });

    expect(result.transactions.map((t) => t.delayedSec)).toEqual([15, 15]);
    expect(slept).toEqual([15_000, 15_000]);
  });

  it("stops cleanly when the sidecar finds nothing left to shield", async () => {
    // No txid means no UTXO above the minimum. That is the normal end of a sweep, not a
    // failure, and treating it as one would make every completed sweep look broken.
    const { wallet } = await connect({ "POST /shield": { body: {} } });
    const result = await wallet.shield({
      splitInto: 3,
      fromTransparent: ["t1a", "t1b", "t1c"],
    });

    expect(result.transactions).toHaveLength(0);
    expect(result.shieldedZat).toBe("0");
  });

  it("reports what already went out when a later transaction fails", async () => {
    // A caller told "it failed" while value is already shielded has been told something
    // false, and will make its next decision on that falsehood.
    let calls = 0;
    const fake = fakeWalletd();
    running = fake;
    const url = await fake.start();

    const wallet = await WalletdWallet.connect({
      url,
      token: TOKEN,
      sleep: async () => {},
      fetch: async (input, init) => {
        if (String(input).endsWith("/shield")) {
          calls += 1;
          if (calls === 1) {
            return Response.json({ txid: "ab".repeat(32), amountZat: "500000", feeZat: "10000" });
          }
          return new Response(JSON.stringify({ code: "send_failed", message: "broadcast failed" }), {
            status: 502,
            headers: { "content-type": "application/json" },
          });
        }
        return globalThis.fetch(input, init);
      },
    });

    await expect(
      wallet.shield({ splitInto: 2, fromTransparent: ["t1a", "t1b"] }),
    ).rejects.toThrow(/after 1 of 2 transaction\(s\); 500000 zatoshis are already shielded/);
  });

  it("refuses a nonsense split count before calling the sidecar", async () => {
    const { wallet, fake } = await connect({ "POST /shield": SHIELD_OK });
    await expect(wallet.shield({ splitInto: 0 })).rejects.toThrow(/positive integer/);
    expect(fake.requests.filter((r) => r.path === "/shield")).toHaveLength(0);
  });
});

describe("unshield", () => {
  const UNSHIELD_OK = {
    body: {
      txid: "bb1ded9e252cfff784aae08add4a79b52424fc91bd304d96bcf41322e7683691",
      feeZat: "10000",
    },
  };

  it("reports the amount that is now public", async () => {
    const { wallet } = await connect({ "POST /unshield": UNSHIELD_OK });
    const result = await wallet.unshield({
      toTransparent: "t1" + "a".repeat(33),
      amountZat: "5000000",
    });

    expect(result.publicAmountZat).toBe("5000000");
    expect(result.feeZat).toBe("10000");
  });

  it("refuses a shielded destination without calling the sidecar", async () => {
    // Named here rather than surfaced from whatever the sidecar says about an address it
    // could not parse.
    const { wallet, fake } = await connect({ "POST /unshield": UNSHIELD_OK });
    await expect(
      wallet.unshield({ toTransparent: "utest1payee", amountZat: "5000000" }),
    ).rejects.toThrow(/transparent address/);
    expect(fake.requests.filter((r) => r.path === "/unshield")).toHaveLength(0);
  });
});
