/**
 * The split-signing round trip, on a real chain.
 *
 *   BYTE_TESTNET=1 \
 *   BYTE_WALLETD_TOKEN=... \
 *   pnpm pczt:run
 *
 * `BYTE_MAINNET=1` instead, and it spends real ZEC.
 *
 * ## What this proves that the unit tests cannot
 *
 * A PCZT is a transaction built in one place, authorized in another, and broadcast from a
 * third. Every stage can be tested on its own and the thing that matters is whether the
 * stages agree: whether a PCZT built here parses there, whether a signature added by the
 * signer survives proving, whether the extractor accepts what the prover produced.
 *
 * Until this script ran, `docs/GAP_AUDIT.md` said "no PCZT has been built, signed, proved
 * and broadcast on a real chain", and that stayed true however good each stage looked in
 * isolation. Byte's whole argument is that a claim without a run behind it is a claim.
 *
 * ## The five stages
 *
 *   create   →  a PCZT, from the same proposal `/send` would have built. No key.
 *   review   →  read what it pays and to whom. No key.
 *   sign     →  check the policy in full, then sign. **The only stage that needs the key.**
 *   prove    →  add the Ironwood proof. No key.
 *   extract  →  verify the proof, rebuild the transaction, broadcast it. No key.
 *
 * Four of the five need no spending key. That is the point of the exercise: a machine can
 * decide what to pay, and a different machine can hold the key and do nothing but read a
 * transaction and answer yes or no.
 *
 * ## What it still does not prove
 *
 * Every stage runs against the same sidecar here, because that is what one machine can
 * demonstrate. It shows the stages agree; it does not show the key was ever somewhere the
 * builder could not reach. Splitting the process across two hosts is a deployment question
 * and this script does not answer it.
 */

import { parseZat } from "@byte-protocol/core";
import { chooseNetwork, mainnetBanner } from "./network-guard.js";

const PRICE_ZAT = process.env.BYTE_TESTNET_PRICE ?? "50000";

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

interface Sidecar {
  get(path: string): Promise<Record<string, unknown>>;
  post(path: string, body?: unknown): Promise<Record<string, unknown>>;
}

/** The sidecar, with its errors reported as the sidecar wrote them rather than as a status. */
function connect(url: string, token: string): Sidecar {
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      throw new Error(
        `${method} ${path} answered ${response.status} (${String(parsed.code)}): ${String(parsed.message)}`,
      );
    }
    return parsed;
  };

  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
  };
}

interface Review {
  outputs: Array<{ recipient: string; amountZat: string }>;
  totalZat: string;
  actionCount: number;
}

function showReview(review: Review, indent = "    "): void {
  for (const output of review.outputs) {
    line(`${indent}${output.amountZat.padStart(12)} zat  to ${output.recipient.slice(0, 24)}…`);
  }
  line(`${indent}total ${review.totalZat} zat across ${review.actionCount} Ironwood action(s)`);
}

async function main(): Promise<void> {
  const choice = chooseNetwork();
  for (const warning of mainnetBanner(choice, PRICE_ZAT)) line(warning);

  const url = process.env.BYTE_WALLETD_URL ?? "http://127.0.0.1:8137";
  const sidecar = connect(url, requireEnv("BYTE_WALLETD_TOKEN"));

  step(1, "Connect");
  const status = await sidecar.get("/status");
  line(`    network ${String(status.network)} (${choice.name})`);
  line(`    synced ${String(status.synced)} at block ${String(status.syncedHeight)}`);
  if (status.network !== choice.network) {
    throw new Error(`the sidecar is on ${String(status.network)}, not ${choice.name}`);
  }
  if (status.synced !== true) throw new Error("the sidecar is not synced; wait and try again");

  const balance = await sidecar.get("/balance");
  line(`    spendable ${String(balance.spendableZat)} zat`);
  const needed = parseZat(PRICE_ZAT) + 20_000n;
  if (parseZat(String(balance.spendableZat)) < needed) {
    throw new Error(
      `not enough spendable value: have ${String(balance.spendableZat)}, need about ${needed}. ` +
        "Send some ZEC to an address from POST /addresses and wait for it to confirm.",
    );
  }

  // Paying this wallet's own address. The point here is the signing path, not the
  // recipient, and a self-payment keeps the value in the wallet for a later run.
  const payTo = String((await sidecar.post("/addresses")).address);

  step(2, "create — build a PCZT. No spending key involved");
  const created = await sidecar.post("/pczt/create", {
    to: payTo,
    amountZat: PRICE_ZAT,
    memo: `BYTE1|${"0".repeat(32)}|${"0".repeat(32)}`,
  });
  const createdHex = String(created.pczt);
  line(`    ${createdHex.length / 2} bytes, fee ${String(created.feeZat)} zat`);
  showReview(created.review as unknown as Review);

  step(3, "review — read it back, as a signer would before agreeing");
  const reviewed = (await sidecar.post("/pczt/review", { pczt: createdHex })) as unknown as Review;
  showReview(reviewed);
  // The builder reported a review of its own. If the two disagreed, one of them is lying
  // about what the transaction pays, which is the whole thing a reviewer is there to catch.
  const builderSaid = JSON.stringify((created.review as unknown as Review).outputs);
  if (JSON.stringify(reviewed.outputs) !== builderSaid) {
    throw new Error("FAILED: the builder's review and an independent review disagree");
  }
  line("    matches what the builder reported");

  step(4, "sign — the only stage that needs the spending key");

  // The cap is proved by being crossed, not by being met. A policy that is only ever tested
  // with a passing value has not been tested: it would look identical if it were never
  // consulted. So refuse first, deliberately, one zatoshi under.
  const everything = reviewed.totalZat;
  const tooTight = (BigInt(everything) - 1n).toString(10);
  let refused = false;
  try {
    await sidecar.post("/pczt/sign", { pczt: createdHex, maxTotalZat: tooTight });
  } catch (error) {
    refused = /over the signer's cap/.test(error instanceof Error ? error.message : "");
  }
  line(`    a cap of ${tooTight} is refused: ${refused ? "yes" : "NO"}`);
  if (!refused) throw new Error("FAILED: the signer accepted a payment over its own cap");

  const signed = await sidecar.post("/pczt/sign", {
    pczt: createdHex,
    maxTotalZat: everything,
  });
  const signedHex = String(signed.pczt);
  line(`    a cap of ${everything} is accepted, and it signed`);
  line(`    ${signedHex.length / 2} bytes`);
  line(`    policy applied: ${JSON.stringify(signed.policyApplied)}`);
  line();
  line("    The cap is set to the review's total because that total INCLUDES CHANGE, and a");
  line("    signer cannot tell change from a payment: the orchard crate's PCZT output keeps");
  line("    `zip32_derivation` — the field that says an output is spendable by this wallet —");
  line("    private, with no accessor. So `maxTotalZat` caps value leaving the wallet plus");
  line("    value returning to it, and `allowRecipients` would have to name a change address");
  line("    that is minted per transaction and cannot be known in advance. The mechanism");
  line("    works, demonstrated above. What it measures is not yet what a user means.");

  step(5, "prove — add the Ironwood proof. No secret needed");
  const proved = await sidecar.post("/pczt/prove", { pczt: signedHex });
  const provedHex = String(proved.pczt);
  line(`    proved, ${provedHex.length / 2} bytes`);

  step(6, "extract — verify the proof, rebuild the transaction, broadcast");
  const sent = await sidecar.post("/pczt/extract", { pczt: provedHex });
  line(`    txid ${String(sent.txid)}`);

  step(7, "Result");
  const checks: Array<[string, boolean, string]> = [
    ["a PCZT was built without a spending key", createdHex.length > 0, `${createdHex.length / 2} bytes`],
    [
      "an independent review agreed with the builder",
      JSON.stringify(reviewed.outputs) === builderSaid,
      `${reviewed.outputs.length} output(s), ${reviewed.totalZat} zat`,
    ],
    ["the signer refused a payment over its cap", refused, `cap ${tooTight}, total ${everything}`],
    [
      "and signed when the cap allowed it",
      (signed.policyApplied as Record<string, unknown>).maxTotalZat === everything,
      JSON.stringify(signed.policyApplied),
    ],
    ["signing changed the PCZT", signedHex !== createdHex, "the signature is in it"],
    ["proving changed it again", provedHex !== signedHex, "the proof is in it"],
    ["it broadcast", typeof sent.txid === "string" && String(sent.txid).length === 64,
      String(sent.txid)],
  ];

  let failed = 0;
  for (const [claim, ok, evidence] of checks) {
    if (!ok) failed += 1;
    line(`    ${ok ? "yes" : "NO "}  ${claim}`);
    line(`         ${evidence}`);
  }

  line();
  line("    Limitations, both real. Every stage ran against one sidecar, which is what one");
  line("    machine can show: it proves the stages agree, not that the key was ever somewhere");
  line("    the builder could not reach. And the signing policy counts change, because the");
  line("    PCZT field that marks an output as this wallet's own is private in the orchard");
  line("    crate, so a cap or an allow list cannot yet express what a person means by them.");
  line();

  if (failed > 0) throw new Error(`${failed} check(s) failed`);
  line(`    Log this run in docs/CHAIN_RUNS.md with txid ${String(sent.txid)}.`);
  line();
}

main().catch((error: unknown) => {
  console.error();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
