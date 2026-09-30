/**
 * The whole protocol, end to end, in one runnable file.
 *
 *   pnpm demo
 *
 * A buyer agent fetches a paywalled report from a seller agent. The seller answers 402, the
 * buyer settles in shielded Zcash, the seller verifies and serves. Then the demo shows the
 * things that usually go unshown: a replay being refused, and a spend guard refusing to pay.
 *
 * It runs against the mock wallet, so it needs no chain and no funds. The same code paths run
 * against `byte-walletd` on testnet — see docs/CHAIN_RUNS.md for a real one.
 */

import { NETWORK_TESTNET } from "@byte-protocol/core";
import { SpendGuard, createByteFetch } from "@byte-protocol/client";
import { createMockPair } from "@byte-protocol/wallet";
import { PRICE_ZAT, startSeller } from "./seller.js";

const line = (text = "") => console.log(text);
const heading = (text: string) => {
  line();
  line(text);
  line("─".repeat(text.length));
};

async function main(): Promise<void> {
  const pair = createMockPair(NETWORK_TESTNET);
  pair.fundPayer("10000000"); // 0.1 TAZ, the same as the faucet gives

  // The mock chain does not mine on its own. Mine a block whenever the buyer broadcasts, so
  // the seller sees a confirmed payment on the retry.
  const send = pair.payer.send.bind(pair.payer);
  pair.payer.send = async (request) => {
    const result = await send(request);
    pair.chain.mine(1);
    return result;
  };

  const seller = await startSeller(pair);

  try {
    heading("1. A buyer pays for a report it has never seen");

    const guard = new SpendGuard({
      maxPerCallZat: "500000",
      maxDailyZat: "2000000",
      allow: ["127.0.0.1"],
    });
    const pay = createByteFetch({ wallet: pair.payer, guard });

    const before = (await pair.payer.balance()).spendableZat;
    line(`  buyer   balance ${before} zat`);
    line(`  buyer   GET ${seller.origin}/report`);

    const response = await pay(`${seller.origin}/report`);
    const body = (await response.json()) as { report: string; txid: string };

    line(`  buyer   got: "${body.report}"`);
    const after = (await pair.payer.balance()).spendableZat;
    line(`  buyer   balance ${after} zat (paid ${PRICE_ZAT} plus fee)`);

    heading("2. What an observer of the chain would see");

    const outputs = await pair.payee.findOutputs(body.txid);
    for (const note of outputs) {
      line(`  pool ${note.pool}, ${note.valueZat} zat, ${note.confirmations} confirmation(s)`);
    }
    line();
    line("  The payment landed in Ironwood, which is the check the verifier actually makes:");
    line("  an address cannot say which pool a payment will reach, so the pool is read");
    line("  off the received note.");
    line();
    line("  On a real chain an observer sees that a shielded transaction happened.");
    line("  Not the amount, not either address, not a balance. The real testnet run in");
    line("  docs/CHAIN_RUNS.md shows the change output landing in Ironwood too, so");
    line("  nothing crossed pools and no net amount was revealed under ZIP 318.");
    line("  (This mock chain does not model change outputs.)");

    heading("3. The same payment, presented twice");

    const replayHeader = Buffer.from(
      JSON.stringify({
        scheme: "byte-zcash-shielded-v1",
        network: NETWORK_TESTNET,
        invoiceId: (await seller.store.list()).invoices[0]?.invoiceId,
        txid: body.txid,
      }),
      "utf8",
    ).toString("base64");

    const replay = await fetch(`${seller.origin}/report`, {
      headers: { "payment-signature": replayHeader },
    });
    line(`  buyer   replayed the payment → HTTP ${replay.status}`);
    line(`  served  ${seller.servedCount()} time(s) in total`);

    heading("4. A spend guard refusing");

    const stingy = new SpendGuard({ maxPerCallZat: "1" });
    const stingyPay = createByteFetch({ wallet: pair.payer, guard: stingy });

    try {
      await stingyPay(`${seller.origin}/report`);
      line("  buyer   paid — which should not happen");
    } catch (error) {
      line(`  buyer   refused to pay: ${error instanceof Error ? error.message : String(error)}`);
      line("  Nothing was broadcast. The guard runs before a transaction is built.");
    }

    heading("What this demo showed");
    line("  · A payment settled in the Ironwood shielded pool.");
    line("  · A memo bound the payment to one invoice and one address.");
    line("  · A replay was refused, because the invoice was consumed atomically.");
    line("  · A spend guard stopped a payment before any value moved.");
    line();
    line("  Guard audit log:");
    for (const entry of guard.auditLog()) {
      line(
        `    ${entry.allowed ? "PAID   " : "REFUSED"} ${entry.amountZat} zat to ${entry.host}` +
          (entry.reason !== undefined ? ` (${entry.reason})` : ""),
      );
    }
    for (const entry of stingy.auditLog()) {
      line(`    REFUSED ${entry.amountZat} zat to ${entry.host} (${entry.reason})`);
    }
    line();
  } finally {
    await seller.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
