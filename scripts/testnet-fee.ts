/**
 * A fee-carrying invoice, paid in one shielded transaction, against real Zcash testnet.
 *
 *   BYTE_TESTNET=1 \
 *   BYTE_WALLETD_URL=http://127.0.0.1:8137 \
 *   BYTE_WALLETD_TOKEN=... \
 *   pnpm test:testnet:fee
 *
 * ## What this proves that the other runs do not
 *
 * Byte's facilitator fee is a **second output on the same transaction**, not a separate
 * payment. That design is the whole reason the fee does not cost a second block, a second
 * ZIP 317 fee, or a second window in which a payer could pay one leg and not the other.
 *
 * It was also, until recently, broken in a way no test caught: `SendRequest` took a single
 * `{ to, amountZat, memo }`, so Byte's own client could not pay an invoice that had two
 * outputs. The fee existed in the issuer, the verifier checked it, and nothing could
 * actually settle one. The unit tests passed because both sides were mocked.
 *
 * So this run exists to show, on a real chain, that:
 *
 * - a fee-carrying invoice settles in **one** transaction,
 * - the payee leg carries the binding memo and the fee leg carries none,
 * - both legs and the change land in **Ironwood**, so nothing crosses a pool and ZIP 318
 *   reveals no net amount,
 * - the verifier accepts it, having checked the fee arrived and not merely that the payee
 *   was paid.
 *
 * ## What it does not prove
 *
 * The fee is enforced by the facilitator's verification and by nothing else. Zcash has no
 * contracts. A payer who pays the payee directly, skipping the facilitator, skips the fee,
 * and this run does not and cannot show otherwise. That limit is in `core/src/fee.ts`,
 * SPEC §5.5 and the README, and it is restated in the output here so a reader of the log
 * cannot come away with the wrong impression.
 *
 * Both roles also run against one wallet, as in the other runs: the fee address is minted
 * from the same sidecar that pays. It shows the transaction shape, not two parties.
 */

import {
  NETWORK_TESTNET,
  feeZatFor,
  newMemoSecret,
  parseZat,
} from "@byte-protocol/core";
import { MemoryInvoiceStore } from "@byte-protocol/stores";
import { InvoiceIssuer, PaymentVerifier } from "@byte-protocol/server";
import { BytePayer, SpendGuard } from "@byte-protocol/client";
import { WalletdWallet } from "@byte-protocol/wallet";

/** What the payee is owed. The fee is added on top, never taken out of this. */
const PRICE_ZAT = process.env.BYTE_TESTNET_PRICE ?? "50000";
/** 250 basis points, 2.5%. Chosen so the fee is a round number against the default price. */
const FEE_BPS = Number(process.env.BYTE_TESTNET_FEE_BPS ?? "250");

const line = (text = ""): void => console.log(text);
const step = (n: number, text: string): void => {
  line();
  line(`${String(n).padStart(2, "0")}. ${text}`);
  line("    " + "─".repeat(text.length));
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} must be set`);
  return value;
}

/** Wait for a transaction to reach `target` confirmations, reporting as it goes. */
async function waitForConfirmations(
  wallet: WalletdWallet,
  txid: string,
  target: number,
  timeoutMs = 20 * 60 * 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let reported = -1;

  while (Date.now() < deadline) {
    const best = (await wallet.findOutputs(txid)).reduce(
      (max, note) => Math.max(max, note.confirmations),
      0,
    );
    if (best !== reported) {
      line(`    ${best} confirmation(s)…`);
      reported = best;
    }
    if (best >= target) return;

    // One block, read from the chain's own consensus branch rather than from a height:
    // NU7's activation heights are TBD in ZIP 259, so a height here would be a forecast
    // driving a real wait.
    const status = await wallet.status();
    const { retryAfterSeconds } = await import("@byte-protocol/core");
    const wait =
      retryAfterSeconds(
        status.consensusBranchId === undefined ? {} : { branchId: status.consensusBranchId },
      ) * 1000;
    await new Promise((resolve) => setTimeout(resolve, wait));
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

  if (!status.synced) throw new Error("the wallet is not synced; wait and try again");
  if (wallet.network !== NETWORK_TESTNET) {
    // Refusing rather than warning: this script spends.
    throw new Error(`refusing to run against ${wallet.network}; this script is testnet-only`);
  }

  const expectedFee = feeZatFor(PRICE_ZAT, { bps: FEE_BPS, payTo: "" });
  const needed = parseZat(PRICE_ZAT) + parseZat(expectedFee) + 20_000n;
  const balance = await wallet.balance();
  line(`    spendable ${balance.spendableZat} zat`);
  if (parseZat(balance.spendableZat) < needed) {
    throw new Error(
      `not enough spendable value: have ${balance.spendableZat}, need about ${needed}. ` +
        "Fund the wallet from a faucet — see docs/TESTNET_RUNS.md.",
    );
  }

  step(2, "Issue an invoice that carries a facilitator fee");
  // The fee address is minted from this wallet so the run can read the fee leg back off
  // the chain afterwards. A real facilitator's fee address belongs to the facilitator.
  const feeAddress = await wallet.newInvoiceAddress();
  const store = new MemoryInvoiceStore();
  const secret = newMemoSecret();
  const issuer = new InvoiceIssuer({
    wallet,
    store,
    secret,
    minConfirmations: 1,
    ttlMs: 30 * 60 * 1000,
    facilitatorFee: { bps: FEE_BPS, payTo: feeAddress },
  });
  const verifier = new PaymentVerifier({ wallet, store, secret });

  const invoice = await issuer.issue(PRICE_ZAT);
  if (invoice.fee === undefined) {
    throw new Error("the issuer produced no fee output; nothing to prove");
  }

  line(`    invoiceId  ${invoice.invoiceId}`);
  line(`    payee owed ${invoice.amount} zat`);
  line(`    fee        ${invoice.fee.amount} zat at ${invoice.fee.bps} bps`);
  line(`    payee leg  ${invoice.payTo}`);
  line(`    fee leg    ${invoice.fee.payTo}`);
  line();
  line("    The ZIP 321 request the payer is handed, with both outputs:");
  line(`    ${invoice.zip321}`);

  if (invoice.payTo === invoice.fee.payTo) {
    // Two legs to one address would collapse into a single output and prove nothing.
    throw new Error("the fee address matched the payee address; this run would prove nothing");
  }

  step(3, "Pay it — one transaction, two outputs");
  const guard = new SpendGuard({
    maxPerCallZat: String(needed),
    maxDailyZat: "10000000",
    allow: ["127.0.0.1"],
  });
  const payer = new BytePayer({ wallet, guard });

  const started = Date.now();
  const paid = await payer.pay(invoice, "http://127.0.0.1/fee-run");
  line(`    txid ${paid.txid}`);
  line(`    network fee ${paid.feeZat} zat (ZIP 317)`);
  line(`    the guard authorized ${guard.spentTodayZat()} zat, which is the price plus the`);
  line("    facilitator fee: the payer's cap covers what actually leaves the wallet");

  step(4, "Wait for it, then read both legs back off the chain");
  await waitForConfirmations(wallet, paid.txid, 1);
  const notes = await wallet.findOutputs(paid.txid);

  for (const note of notes) {
    line(
      `    ${note.pool.padEnd(9)} ${note.valueZat.padStart(12)} zat  ` +
        `${note.confirmations} conf  ${note.memo === undefined ? "(no memo)" : note.memo}`,
    );
  }

  step(5, "Verify it as the facilitator would");
  const result = await verifier.verify(invoice.invoiceId, paid.txid);
  line(`    valid: ${result.valid}`);
  if (!result.valid) {
    throw new Error(`FAILED: the verifier rejected this payment: ${JSON.stringify(result)}`);
  }

  step(6, "Result");

  // Each of these is a claim Byte makes in writing. Checking them here means the log is a
  // record of what the chain did, rather than of what the script hoped it would do.
  const payeeLeg = notes.find((n) => n.valueZat === invoice.amount && n.memo !== undefined);
  const feeLeg = notes.find(
    (n) => n.valueZat === invoice.fee?.amount && n.memo === undefined,
  );
  const outsideIronwood = notes.filter((n) => n.pool !== "ironwood");

  const checks: Array<[string, boolean, string]> = [
    [
      "settled in one transaction",
      notes.length >= 2,
      `${notes.length} outputs, all under txid ${paid.txid}`,
    ],
    [
      "the payee leg arrived, carrying the memo",
      payeeLeg !== undefined,
      payeeLeg === undefined ? "NOT FOUND" : `${payeeLeg.valueZat} zat, memo ${payeeLeg.memo}`,
    ],
    [
      "the fee leg arrived, carrying none",
      feeLeg !== undefined,
      feeLeg === undefined ? "NOT FOUND" : `${feeLeg.valueZat} zat, no memo`,
    ],
    [
      "the fee matched the published rate",
      invoice.fee.amount === expectedFee,
      `${invoice.fee.amount} zat, and ${FEE_BPS} bps of ${PRICE_ZAT} is ${expectedFee}`,
    ],
    [
      "every output landed in Ironwood",
      outsideIronwood.length === 0,
      outsideIronwood.length === 0
        ? `${notes.length} output(s), no pool crossed, nothing revealed under ZIP 318`
        : `${outsideIronwood.length} output(s) outside: ${outsideIronwood.map((n) => n.pool).join(", ")}`,
    ],
    ["the verifier accepted it", result.valid, "checked the amount, the memo and the fee"],
  ];

  let failed = 0;
  for (const [claim, ok, evidence] of checks) {
    if (!ok) failed += 1;
    line(`    ${ok ? "yes" : "NO "}  ${claim}`);
    line(`         ${evidence}`);
  }

  line();
  line(`    ${Math.round((Date.now() - started) / 1000)}s from payment to verification.`);
  line();
  line("    Limitation, restated so the log carries it: the fee is enforced by the");
  line("    facilitator's verification and by nothing else. Zcash has no contracts, so a");
  line("    payer who pays the payee directly and skips the facilitator skips the fee.");
  line("    This run shows the transaction shape, not an enforcement Byte does not have.");
  line();

  if (failed > 0) {
    throw new Error(`${failed} claim(s) failed; this run is not evidence of anything good`);
  }
  line(`    Log this run in docs/TESTNET_RUNS.md with txid ${paid.txid}.`);
  line();
}

main().catch((error: unknown) => {
  console.error();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
