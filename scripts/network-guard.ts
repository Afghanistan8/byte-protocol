/**
 * Which chain a script is allowed to touch, and how loudly it says so.
 *
 * ## Why this is not just an `if`
 *
 * These scripts move money. On testnet that money is worthless by design, which is the
 * whole reason `BYTE_TESTNET=1` was a cheap thing to ask for. On mainnet the same code
 * path spends real ZEC, and the failure mode is not a red test but a payment.
 *
 * So mainnet is a separate, explicit opt-in rather than the absence of a testnet check.
 * The distinction matters: a guard that reads "refuse unless testnet" turns into "allow
 * anything" the moment someone deletes a line, and nothing about the deletion looks
 * dangerous in a diff. A guard that requires `BYTE_MAINNET=1` to be *present* cannot fail
 * open. Setting both is refused outright, because a script that has been told two
 * contradictory things should not pick one.
 *
 * The scripts were written testnet-only on purpose and this does not change that default.
 * It adds a door with a handle on it, rather than taking the door off.
 */

import { NETWORK_MAINNET, NETWORK_TESTNET, type ByteNetwork } from "@byte-protocol/core";

export interface NetworkChoice {
  network: ByteNetwork;
  /** True when this run spends money that is worth something. */
  real: boolean;
  /** A human name for logs: "mainnet" or "testnet". */
  name: string;
}

export class NetworkRefused extends Error {}

/**
 * Read the chosen network from the environment, or throw with an explanation.
 *
 * `env` is injectable so this is testable without mutating `process.env`, which leaks
 * between test files and produces failures that depend on execution order.
 */
export function chooseNetwork(env: Record<string, string | undefined> = process.env): NetworkChoice {
  const testnet = env.BYTE_TESTNET === "1";
  const mainnet = env.BYTE_MAINNET === "1";

  if (testnet && mainnet) {
    throw new NetworkRefused(
      "BYTE_TESTNET=1 and BYTE_MAINNET=1 are both set. Refusing to guess which you meant: " +
        "one of them spends real money. Unset the one you did not intend.",
    );
  }

  if (mainnet) {
    return { network: NETWORK_MAINNET, real: true, name: "mainnet" };
  }

  if (testnet) {
    return { network: NETWORK_TESTNET, real: false, name: "testnet" };
  }

  throw new NetworkRefused(
    "Refusing to run: set BYTE_TESTNET=1, or BYTE_MAINNET=1 to use the real chain.\n" +
      "Mainnet spends real ZEC. Nothing here is reversible once broadcast.",
  );
}

/**
 * Check that the wallet a script actually reached is on the chain it was told to use.
 *
 * The environment variable states an intention; the sidecar states a fact. A mismatch
 * means the sidecar is configured for the other chain, and continuing would either waste a
 * run or spend real money that was meant to be worthless. Either way it stops here.
 */
export function assertWalletMatches(choice: NetworkChoice, walletNetwork: string): void {
  if (walletNetwork === choice.network) return;

  const reached =
    walletNetwork === NETWORK_MAINNET
      ? "mainnet"
      : walletNetwork === NETWORK_TESTNET
        ? "testnet"
        : walletNetwork;

  throw new NetworkRefused(
    `You asked for ${choice.name}, but byte-walletd is on ${reached}. ` +
      "Point BYTE_WALLETD_URL at the right sidecar, or start one with " +
      `BYTE_WALLETD_NETWORK=${choice.name === "mainnet" ? "main" : "test"}.`,
  );
}

/**
 * The banner a mainnet run prints before it does anything.
 *
 * Returned rather than printed so a test can read it, and so a caller decides where it
 * goes. Empty on testnet: a warning shown every time is a warning nobody reads.
 */
export function mainnetBanner(choice: NetworkChoice, spendZat?: string): string[] {
  if (!choice.real) return [];

  const lines = [
    "",
    "  ┌──────────────────────────────────────────────────────────────────┐",
    "  │  MAINNET. This spends real ZEC and nothing here is reversible.   │",
    "  └──────────────────────────────────────────────────────────────────┘",
  ];
  if (spendZat !== undefined) {
    lines.push(`  About to risk up to ${spendZat} zatoshis (${Number(spendZat) / 1e8} ZEC).`);
  }
  lines.push("");
  return lines;
}
