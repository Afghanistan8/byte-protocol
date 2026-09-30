/**
 * The guard that decides whether a script may spend real money.
 *
 * Worth testing more carefully than most things here, because the expensive failure is
 * silent: a guard that wrongly allows mainnet does not throw, it succeeds, and the
 * evidence is a transaction.
 */

import { describe, expect, it } from "vitest";
import { NETWORK_MAINNET, NETWORK_TESTNET } from "@byte-protocol/core";
import {
  NetworkRefused,
  assertWalletMatches,
  chooseNetwork,
  mainnetBanner,
} from "./network-guard.js";

describe("choosing a network", () => {
  it("refuses when nothing is set, rather than defaulting to either", () => {
    expect(() => chooseNetwork({})).toThrow(NetworkRefused);
  });

  it("chooses testnet for BYTE_TESTNET=1, and says it is not real money", () => {
    const choice = chooseNetwork({ BYTE_TESTNET: "1" });
    expect(choice.network).toBe(NETWORK_TESTNET);
    expect(choice.real).toBe(false);
    expect(choice.name).toBe("testnet");
  });

  it("chooses mainnet for BYTE_MAINNET=1, and says it is real money", () => {
    const choice = chooseNetwork({ BYTE_MAINNET: "1" });
    expect(choice.network).toBe(NETWORK_MAINNET);
    expect(choice.real).toBe(true);
    expect(choice.name).toBe("mainnet");
  });

  it("refuses when both are set rather than picking one", () => {
    // Picking either would be a guess, and one of the guesses spends real money.
    expect(() => chooseNetwork({ BYTE_TESTNET: "1", BYTE_MAINNET: "1" })).toThrow(NetworkRefused);
  });

  // The value must be exactly "1". Anything else is someone half-remembering the flag, and
  // a guard that accepts "true", "yes" or "0" as consent is not a guard.
  it.each(["0", "true", "yes", "", "1 ", "TRUE", "on"])(
    "does not accept BYTE_MAINNET=%o as consent",
    (value) => {
      expect(() => chooseNetwork({ BYTE_MAINNET: value })).toThrow(NetworkRefused);
    },
  );

  it.each(["0", "true", "yes", "", "on"])("does not accept BYTE_TESTNET=%o", (value) => {
    expect(() => chooseNetwork({ BYTE_TESTNET: value })).toThrow(NetworkRefused);
  });

  it("cannot fail open: an unrelated environment never selects a chain", () => {
    expect(() => chooseNetwork({ NODE_ENV: "production", BYTE_WALLETD_TOKEN: "x" })).toThrow(
      NetworkRefused,
    );
  });
});

describe("matching the wallet actually reached", () => {
  const testnet = chooseNetwork({ BYTE_TESTNET: "1" });
  const mainnet = chooseNetwork({ BYTE_MAINNET: "1" });

  it("passes when the sidecar is on the chosen chain", () => {
    expect(() => assertWalletMatches(testnet, NETWORK_TESTNET)).not.toThrow();
    expect(() => assertWalletMatches(mainnet, NETWORK_MAINNET)).not.toThrow();
  });

  it("refuses a testnet run that reached a mainnet sidecar", () => {
    // The dangerous direction: a run believed to be worthless, spending real ZEC.
    expect(() => assertWalletMatches(testnet, NETWORK_MAINNET)).toThrow(/mainnet/);
  });

  it("refuses a mainnet run that reached a testnet sidecar", () => {
    expect(() => assertWalletMatches(mainnet, NETWORK_TESTNET)).toThrow(/testnet/);
  });

  it("refuses a chain it does not recognise at all", () => {
    expect(() => assertWalletMatches(mainnet, "zcash:deadbeef")).toThrow(NetworkRefused);
  });

  it("names the sidecar's chain in the message, so the fix is obvious", () => {
    expect(() => assertWalletMatches(mainnet, NETWORK_TESTNET)).toThrow(
      /BYTE_WALLETD_NETWORK=main/,
    );
  });
});

describe("the mainnet banner", () => {
  it("says nothing on testnet, so the warning keeps its meaning", () => {
    expect(mainnetBanner(chooseNetwork({ BYTE_TESTNET: "1" }))).toEqual([]);
    expect(mainnetBanner(chooseNetwork({ BYTE_TESTNET: "1" }), "100000")).toEqual([]);
  });

  it("warns on mainnet, and names the amount in ZEC as well as zatoshis", () => {
    const lines = mainnetBanner(chooseNetwork({ BYTE_MAINNET: "1" }), "100000").join("\n");
    expect(lines).toMatch(/MAINNET/);
    expect(lines).toMatch(/real ZEC/);
    expect(lines).toMatch(/not reversible|nothing here is reversible/i);
    expect(lines).toContain("100000 zatoshis");
    expect(lines).toContain("0.001 ZEC");
  });

  it("still warns when no amount is known", () => {
    const lines = mainnetBanner(chooseNetwork({ BYTE_MAINNET: "1" })).join("\n");
    expect(lines).toMatch(/MAINNET/);
  });
});
