/**
 * A real Byte seller, and the dashboard served next to it, so a browser wallet can settle
 * a real invoice.
 *
 *   BYTE_TESTNET=1 \      # or BYTE_MAINNET=1 for the real chain
 *   BYTE_WALLETD_URL=http://127.0.0.1:8137 \
 *   BYTE_WALLETD_TOKEN=... \
 *   pnpm seller
 *
 * Then open <http://127.0.0.1:8402/> and pay from any Zcash wallet.
 *
 * On mainnet this mints invoices for **real ZEC**. The seller only ever receives, so its
 * own wallet needs no funds and holds a spending key to nothing until someone pays it.
 * The payer is where the real money is, and the payer is not this process.
 *
 * ## The three gaps this closes
 *
 * The browser run logged on 2026-09-30 proved the wallet leg and was explicit that it
 * proved nothing else. Its three stated limits were:
 *
 * 1. **No seller verified it.** The page built a *practice* invoice against a fixed demo
 *    key, so the memo was well-formed but no Byte server had issued it and nothing marked
 *    it paid. Here the invoice comes from a real `InvoiceIssuer`, minted against a real
 *    wallet, and a real `PaymentVerifier` decides whether it was settled.
 * 2. **The memo was not read back off the chain.** The browser holds no viewing key, so
 *    the evidence stopped at a broadcast txid. This process holds one, through the
 *    sidecar, so it reads the payment back and returns what it found.
 * 3. **The recipient was recorded only as the wallet displayed it**, truncated. The
 *    invoice address is minted here and reported in full.
 *
 * ## Why it is served rather than deployed
 *
 * The seller needs a wallet that can mint addresses and read the chain. Putting that on a
 * public host means a hot wallet reachable from the internet, which is a decision for
 * whoever owns the funds and not something a script should quietly arrange. Running it
 * locally proves exactly the same protocol facts.
 *
 * Serving the dashboard from this same origin is not cosmetic either: the deployed site is
 * HTTPS, a local seller is HTTP, and a browser blocks that as mixed content. Same origin,
 * no exception asked for.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseZat } from "@byte-protocol/core";
import { newMemoSecret } from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import { WalletdWallet } from "@byte-protocol/wallet";
import { createSellerRoutes } from "./seller-routes.js";
import {
  assertWalletMatches,
  chooseNetwork,
  mainnetBanner,
} from "./network-guard.js";

const PRICE_ZAT = process.env.BYTE_TESTNET_PRICE ?? "100000";
const PORT = Number(process.env.BYTE_SELLER_PORT ?? "8402");
const DASHBOARD = fileURLToPath(new URL("../apps/site/app/index.html", import.meta.url));

const line = (text = ""): void => console.log(text);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} must be set`);
  return value;
}

async function main(): Promise<void> {
  const choice = chooseNetwork();
  for (const warning of mainnetBanner(choice)) line(warning);

  const wallet = await WalletdWallet.connect({
    url: process.env.BYTE_WALLETD_URL ?? "http://127.0.0.1:8137",
    token: requireEnv("BYTE_WALLETD_TOKEN"),
  });
  const status = await wallet.status();
  assertWalletMatches(choice, wallet.network);
  if (!status.synced) throw new Error("the wallet is not synced; wait and try again");

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

  const page = readFileSync(DASHBOARD, "utf8");

  // The routing lives in `seller-routes.ts` so it can be tested against the mock chain.
  // Everything this file adds — the environment, the socket, the log — is the part a test
  // cannot drive anyway.
  const routes = createSellerRoutes({
    issuer,
    verifier,
    wallet,
    priceZat: PRICE_ZAT,
    onEvent: (event) => {
      line();
      if (event.kind === "issued") {
        line(`issued ${event.invoiceId}`);
        line(`  ${event.amountZat} zat to ${event.payTo}`);
      } else if (event.kind === "settled") {
        line(`SETTLED ${event.invoiceId}`);
        line(`  txid ${event.txid}`);
      } else {
        line(`not settled yet: ${event.invoiceId} — ${event.reason}`);
      }
    },
  });

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const method = req.method ?? "GET";

      // The page is same-origin, so this is not needed for the intended flow. It is here
      // because a reader will try curl and a second tab, and a confusing CORS error would
      // send them looking in the wrong place.
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type");
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);

      try {
        const result = await routes.handle(method, path, Buffer.concat(chunks).toString("utf8"));
        if (result === null) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "no such route" }));
          return;
        }
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
      } catch (error) {
        // Reported rather than swallowed: a seller that fails silently looks to the page
        // exactly like a payment that was refused.
        const message = error instanceof Error ? error.message : String(error);
        line(`error on ${method} ${path}: ${message}`);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  const balance = await wallet.balance();
  line(`A real Byte seller is running on ${choice.name}.`);
  line();
  line(`  open          http://127.0.0.1:${PORT}/`);
  line(`  network       ${wallet.network}`);
  line(`  synced        block ${status.syncedHeight}`);
  line(`  seller wallet ${balance.spendableZat} zat spendable`);
  line(`  price         ${PRICE_ZAT} zat (${Number(parseZat(PRICE_ZAT)) / 1e8} ZEC)`);
  line();
  line("In the page: open the Wallet page and use the seller box at the top. It fetches a");
  line("real invoice from this process. Pay it from any wallet, by the page's own button if");
  line("the wallet has a web API, or by copying the ZIP-321 request if it has not, then");
  line("paste the transaction ID back in. This process verifies it either way and reads the");
  line("payment back off the chain with its viewing key.");
  line();
  line("The seller and the payer are two different wallets only if the paying wallet holds");
  line("different funds from this sidecar. If they are the same wallet, say so in the log.");
  line();
  line("Ctrl-C to stop.");

  process.on("SIGINT", () => {
    line();
    line(`${routes.issued.size} invoice(s) issued this session:`);
    for (const [id, record] of routes.issued) {
      line(`  ${id}  ${record.amountZat} zat  ${record.settledBy ?? "not settled"}`);
    }
    server.close(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  console.error();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
