/**
 * The whole protocol, against real Zcash testnet.
 *
 *   BYTE_TESTNET=1 \
 *   BYTE_WALLETD_URL=http://127.0.0.1:8137 \
 *   BYTE_WALLETD_TOKEN=... \
 *   pnpm test:testnet
 *
 * Refuses to run without `BYTE_TESTNET=1`. It spends real TAZ and takes minutes, so it is
 * never part of the ordinary suite — a test that costs money should be started deliberately.
 *
 * What it proves that the mock cannot: that the x402 adapter, the issuer, the verifier and
 * the sidecar agree with each other **and** with a real chain. Everything else in this
 * repository is exercised against a deterministic mock, which is honest about a great deal
 * but cannot catch a disagreement with consensus, a byte-order mistake, or a memo that does
 * not survive encryption.
 *
 * Both roles run against one wallet: the seller mints invoice addresses from the same
 * sidecar the buyer spends from. That is a genuine limitation — it does not prove two
 * separate wallets can transact — and it is stated in the output rather than glossed.
 */

import { createServer } from "node:http";
import { NETWORK_TESTNET, newMemoSecret } from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import { SpendGuard } from "@byte-protocol/client";
import { WalletdWallet } from "@byte-protocol/wallet";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  createX402Fetch,
  createX402Gate,
  encodeHeader,
} from "@byte-protocol/adapter-x402";

const PRICE_ZAT = process.env.BYTE_TESTNET_PRICE ?? "50000";

const line = (text = "") => console.log(text);
const step = (n: number, text: string) => {
  line();
  line(`${String(n).padStart(2, "0")}. ${text}`);
  line("    " + "─".repeat(text.length));
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set`);
  }
  return value;
}

/** Wait for a transaction to reach `target` confirmations, reporting as it goes. */
async function waitForConfirmations(
  wallet: WalletdWallet,
  txid: string,
  target: number,
  timeoutMs = 20 * 60 * 1000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let reported = -1;

  while (Date.now() < deadline) {
    const notes = await wallet.findOutputs(txid);
    const best = notes.reduce((max, note) => Math.max(max, note.confirmations), 0);

    if (best !== reported) {
      line(`    ${best} confirmation(s)…`);
      reported = best;
    }
    if (best >= target) return best;

    // The Zcash block target is 75 seconds (ZIP 208), so polling faster than this only
    // loads the light server without finding anything new.
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }

  throw new Error(`transaction ${txid} did not reach ${target} confirmations in time`);
}

async function main(): Promise<void> {
  if (process.env.BYTE_TESTNET !== "1") {
    line("Refusing to run: set BYTE_TESTNET=1.");
    line("This spends real TAZ against Zcash testnet and takes several minutes.");
    process.exitCode = 1;
    return;
  }

  const url = process.env.BYTE_WALLETD_URL ?? "http://127.0.0.1:8137";
  const token = requireEnv("BYTE_WALLETD_TOKEN");

  step(1, "Connect to byte-walletd");
  const wallet = await WalletdWallet.connect({ url, token });
  const status = await wallet.status();
  line(`    network ${wallet.network}`);
  line(`    synced ${status.synced} at block ${status.syncedHeight}`);

  if (!status.synced) {
    throw new Error("the wallet is not synced; wait for it to catch up and try again");
  }
  if (wallet.network !== NETWORK_TESTNET) {
    // Refusing rather than warning: this script spends, and it has only ever been meant for
    // testnet.
    throw new Error(`refusing to run against ${wallet.network}; this script is testnet-only`);
  }

  const balance = await wallet.balance();
  line(`    spendable ${balance.spendableZat} zat`);
  if (BigInt(balance.spendableZat) < BigInt(PRICE_ZAT) + 20_000n) {
    throw new Error(
      `not enough spendable value: have ${balance.spendableZat}, need about ${
        BigInt(PRICE_ZAT) + 20_000n
      }. Fund the wallet from a faucet — see docs/TESTNET_RUNS.md.`,
    );
  }

  step(2, "Start a seller gated by the x402 adapter");
  const store = new MemoryInvoiceStore();
  const secret = newMemoSecret();
  const issuer = new InvoiceIssuer({
    wallet,
    store,
    secret,
    minConfirmations: 1,
    ttlMs: 30 * 60 * 1000,
  });
  const verifier = new PaymentVerifier({ wallet, store, secret });
  const gate = createX402Gate({ issuer, verifier, priceZat: PRICE_ZAT });

  let served = 0;
  let lastInvoiceId: string | undefined;

  const server = createServer((req, res) => {
    void (async () => {
      const result = await gate({
        header: (name) => (req.headers[name.toLowerCase()] as string | undefined) ?? null,
      });
      if (!result.paid) {
        const accepts = (result.response.body as { accepts?: Array<{ extra?: { invoiceId?: string } }> })
          .accepts;
        lastInvoiceId = accepts?.[0]?.extra?.invoiceId ?? lastInvoiceId;
        res.writeHead(result.response.status, result.response.headers);
        res.end(JSON.stringify(result.response.body));
        return;
      }
      served += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ report: "paid resource", txid: result.txid }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  const origin = `http://127.0.0.1:${address.port}`;
  line(`    listening on ${origin}, price ${PRICE_ZAT} zat`);

  try {
    step(3, "Buy the resource with a real shielded payment");
    line("    Building and proving the transaction. The first send downloads the Sapling");
    line("    proving parameters, about 50 MB, once.");

    const guard = new SpendGuard({
      maxPerCallZat: String(BigInt(PRICE_ZAT) * 2n),
      maxDailyZat: "10000000",
      allow: ["127.0.0.1"],
    });

    let paidTxid: string | undefined;
    const pay = createX402Fetch({
      wallet,
      guard,
      // The first attempt will be 402 while the payment confirms, so allow the loop to
      // settle once and then poll for confirmations ourselves rather than paying twice.
      maxPayments: 1,
      fetch: async (input, init) => globalThis.fetch(input as string, init),
    });

    const started = Date.now();
    const first = await pay(`${origin}/report`);

    if (first.status === 200) {
      const body = (await first.json()) as { txid: string };
      paidTxid = body.txid;
    } else {
      // Expected: the payment was broadcast but has not confirmed yet. Find it, wait, and
      // present the same claim again.
      const failure = (await first.json()) as { reason?: string; message?: string };
      line(`    first retry answered ${first.status} (${failure.reason ?? "?"}) — as expected`);

      const audit = guard.auditLog().filter((e) => e.allowed);
      const invoiceId = audit.at(-1)?.invoiceId ?? lastInvoiceId;
      if (invoiceId === undefined) throw new Error("could not identify the invoice just paid");

      const invoice = await store.get(invoiceId);
      if (invoice === undefined) throw new Error(`invoice ${invoiceId} is not in the store`);

      line(`    invoice ${invoiceId}`);
      line("    waiting for the payment to be mined…");

      // Find the transaction by asking the store what settled it, or by waiting for the
      // verifier to see it.
      const deadline = Date.now() + 20 * 60 * 1000;
      let found: string | undefined;
      while (Date.now() < deadline && found === undefined) {
        const refreshed = await store.get(invoiceId);
        if (refreshed?.txid !== undefined) {
          found = refreshed.txid;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        const retry = await pay(`${origin}/report`);
        if (retry.status === 200) {
          found = ((await retry.json()) as { txid: string }).txid;
        }
      }

      if (found === undefined) throw new Error("the payment never confirmed");
      paidTxid = found;
    }

    const elapsed = Math.round((Date.now() - started) / 1000);
    line(`    settled by ${paidTxid} in ${elapsed}s`);

    step(4, "Read the payment back off the chain");
    await waitForConfirmations(wallet, paidTxid, 1);
    const notes = await wallet.findOutputs(paidTxid);

    for (const note of notes) {
      line(
        `    ${note.pool.padEnd(9)} ${note.valueZat.padStart(12)} zat  ` +
          `${note.confirmations} conf  ${note.memo === undefined ? "(no memo)" : note.memo}`,
      );
    }

    const wrongPool = notes.filter((n) => n.pool !== "ironwood");
    if (wrongPool.length > 0) {
      throw new Error(
        `FAILED: ${wrongPool.length} output(s) landed outside Ironwood: ${wrongPool
          .map((n) => n.pool)
          .join(", ")}`,
      );
    }

    step(5, "Result");
    line(`    resource served: ${served} time(s)`);
    line(`    every output in the Ironwood pool: yes (${notes.length} output(s))`);
    line(`    memo survived the chain: ${notes.some((n) => n.memo?.startsWith("BYTE1|")) ? "yes" : "NO"}`);
    line(`    guard decisions: ${guard.auditLog().length}, spent ${guard.spentTodayZat()} zat`);
    line();
    line("    Limitation: both roles ran against one wallet, so this does not prove two");
    line("    separate wallets can transact. It proves the adapter, the issuer, the");
    line("    verifier and the sidecar agree with each other and with the chain.");
    line();
    line(`    Log this run in docs/TESTNET_RUNS.md with txid ${paidTxid}.`);
    line();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  console.error();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
