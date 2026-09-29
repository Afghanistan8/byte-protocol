/**
 * The Byte console, with a node that has actually done some business.
 *
 *   pnpm console
 *
 * Runs the marketplace demo's traffic first, so the console has real invoices, real
 * settlements and a real guard audit log to show, then serves the console against it.
 */

import { NETWORK_TESTNET, newMemoSecret } from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import { SpendGuard } from "@byte-protocol/client";
import { startConsole } from "@byte-protocol/console";
import { createMockPair, viewOnly } from "@byte-protocol/wallet";

const TOKEN = process.env.BYTE_CONSOLE_TOKEN ?? "demo-console-token-0123456789abcd";

async function main(): Promise<void> {
  const pair = createMockPair(NETWORK_TESTNET);
  pair.fundPayer("50000000");

  const invoices = new MemoryInvoiceStore();
  const secret = newMemoSecret();
  const wallet = viewOnly(pair.payee);
  const issuer = new InvoiceIssuer({ wallet, store: invoices, secret });
  const verifier = new PaymentVerifier({ wallet, store: invoices, secret });

  const guard = new SpendGuard({
    maxPerCallZat: "500000",
    maxDailyZat: "5000000",
    allow: ["data.example.com", "models.example.com"],
  });

  // Some settled payments.
  for (const [amount, host] of [
    ["100000", "data.example.com"],
    ["250000", "models.example.com"],
    ["75000", "data.example.com"],
  ] as const) {
    const invoice = await issuer.issue(amount);
    await guard.authorize({ amountZat: amount, url: `https://${host}/x`, invoiceId: invoice.invoiceId });
    const { txid } = await pair.payer.send({
      to: invoice.payTo,
      amountZat: amount,
      memo: invoice.memo,
    });
    pair.chain.mine(1);
    await verifier.verify(invoice.invoiceId, txid);
  }

  // One still waiting to be paid, and one the guard refused.
  await issuer.issue("400000");
  await guard.authorize({ amountZat: "9000000", url: "https://models.example.com/expensive" });
  await guard.authorize({ amountZat: "1000", url: "https://unknown.example.org/x" });

  const running = await startConsole({
    wallet,
    invoices,
    guard,
    token: TOKEN,
    label: "byte demo node",
    port: Number.parseInt(process.env.PORT ?? "8765", 10),
  });

  console.log();
  console.log("  Byte console running at " + running.url);
  console.log("  Owner token: " + TOKEN);
  console.log();
  console.log("  It is owner-only: the page renders nothing until the token is accepted.");
  console.log("  Ctrl-C to stop.");
  console.log();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
