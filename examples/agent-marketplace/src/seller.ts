/**
 * A seller agent.
 *
 * Serves a resource behind a Byte paywall, over plain Node HTTP so the example depends on
 * the protocol and nothing else.
 *
 * Run it with the mock wallet (no chain, no funds) or against a real byte-walletd. The
 * protocol is identical either way — that is the point of the wallet interface.
 */

import { createServer } from "node:http";
import { NETWORK_TESTNET, newMemoSecret } from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import { createMockPair, viewOnly } from "@byte-protocol/wallet";
import type { MockPair } from "@byte-protocol/wallet";

export const PRICE_ZAT = "100000";

export interface Seller {
  origin: string;
  close: () => Promise<void>;
  /** How many times the resource was actually served. */
  servedCount: () => number;
  store: MemoryInvoiceStore;
}

/**
 * Start a paywalled resource server.
 *
 * The secret is generated here because this is a demo. In production it comes from the
 * environment and must be stable across restarts — a secret that changes invalidates every
 * outstanding invoice, because their memos no longer bind.
 */
export async function startSeller(pair: MockPair): Promise<Seller> {
  const store = new MemoryInvoiceStore();
  const secret = newMemoSecret();

  // The seller holds a VIEW-ONLY wallet. It can mint addresses and read payments; it cannot
  // spend. There is no `send` on this type.
  const wallet = viewOnly(pair.payee);

  const issuer = new InvoiceIssuer({ wallet, store, secret, minConfirmations: 1 });
  const verifier = new PaymentVerifier({ wallet, store, secret });

  let served = 0;

  const server = createServer((req, res) => {
    void (async () => {
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };

      const header = req.headers["payment-signature"] as string | undefined;

      if (header === undefined) {
        const invoice = await issuer.issue(PRICE_ZAT);
        console.log(`  seller  → 402, invoice ${invoice.invoiceId} for ${PRICE_ZAT} zat`);
        json(
          402,
          { accepts: [invoice] },
          { "payment-required": Buffer.from(JSON.stringify(invoice), "utf8").toString("base64") },
        );
        return;
      }

      const claim = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
        invoiceId: string;
        txid: string;
      };

      const result = await verifier.verify(claim.invoiceId, claim.txid);

      if (!result.ok) {
        console.log(`  seller  → refused: ${result.reason} (${result.message})`);
        json(result.reason === "replay" ? 409 : 402, {
          reason: result.reason,
          message: result.message,
        });
        return;
      }

      served += 1;
      console.log(
        `  seller  → 200, settled by ${result.txid.slice(0, 16)}… in the ${result.note.pool} pool`,
      );
      json(200, {
        report: "Shielded agent payments, Q3: revenue up, counterparties unknowable.",
        txid: result.txid,
      });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    servedCount: () => served,
    store,
  };
}

/** Start a seller with its own mock chain, for running standalone. */
export async function startStandaloneSeller(): Promise<{ seller: Seller; pair: MockPair }> {
  const pair = createMockPair(NETWORK_TESTNET);
  return { seller: await startSeller(pair), pair };
}
