/**
 * The dashboard's address check, run against real addresses.
 *
 * The practice-invoice builder validated its amount carefully — junk, zero, negative and
 * over-precision are all refused — and accepted literally anything in the address field,
 * including the string "not-an-address". The payment then failed inside the wallet, several
 * clicks later, with the wallet's own wording. This is the check that closes that gap.
 *
 * The addresses below are real ones from this project's own mainnet and testnet runs, so a
 * change that tightens the pattern too far fails here rather than in front of someone
 * trying to get paid. That is the risk worth testing: a validator that rejects junk is easy,
 * and one that also accepts every legitimate address is the hard half.
 *
 * As with `balance-reader.test.ts`, the function is extracted from `index.html` and the real
 * source runs, so editing the page breaks the test rather than the page.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PAGE = fileURLToPath(new URL("./index.html", import.meta.url));

function loadCheck(): (address: string) => string | null {
  const html = readFileSync(PAGE, "utf8").replace(/\r\n/g, "\n");
  const start = html.indexOf("  var SHIELDED_ADDRESS =");
  if (start < 0) throw new Error("SHIELDED_ADDRESS is no longer in index.html");
  const fnStart = html.indexOf("  function shieldedAddressProblem(address) {", start);
  const fnEnd = html.indexOf("\n  }\n", fnStart) + 4;
  const src = html.slice(start, fnStart) + html.slice(fnStart, fnEnd);
  return new Function(`${src}\nreturn shieldedAddressProblem;`)() as (a: string) => string | null;
}

const problem = loadCheck();
const ok = (address: string): boolean => problem(address) === null;

// Every one of these was used by this project on a real chain.
const REAL_MAINNET = [
  // The payer in CHAIN_RUNS run 4.
  "u1s5v6dkn6l4vrjg2e5jd75wd57ywq5f6s8weet0g59afep5pvskpznkxjf0rvztw56ejauuvarwh7ra7t7ucxuu4t5ekm2hqrf5c6ners76zp6jn6gll3xaxsjh7fyj6kcdwlnau7eer2msael6j49dsgzrkfj2cjuf82lveskvdprs79",
  // The seller's invoice address in run 4.
  "u1cehhzpjevhu6mrmaxs8qkucygrlumsm6myzc4j3fct6m9w202pyqydvfq4tl67ngrckz3jurgx2yxgadaj0gs7mxajpeeqvtkgeqcrjt",
  // The fee leg in run 5.
  "u1jhlkz7n5lkw0272axt7vxzpt3f80va6t2a5c9f24yh0dau4qjennadpjehwxa269rwdpwx8c7menh0m5rg0p286d6yfvzfk2kggnl9ww",
];

const REAL_TESTNET = [
  // The faucet deposit in run 1.
  "utest1xghzan2ngrekdl2pw3cfnu8cnkucmvezevcvlc59jckjhpra6ykkrvmjq9xelp5t9692kmh63e7uurzqvckvv6xy4g3nrl6c35jxjxcu",
  // The invoice address in run 1.
  "utest1nmxcdnkh7e2lq4dqzaj22r4j0zzy37lr3y4vtjw23el3t4wte78plujfgkjda2mjy9we4ay4hk3cfegp0zk29rhx2gs6r0k7f57jzxxx",
];

describe("addresses this project has actually paid", () => {
  it.each(REAL_MAINNET)("accepts the mainnet address %s", (address) => {
    expect(problem(address)).toBeNull();
  });

  it.each(REAL_TESTNET)("accepts the testnet address %s", (address) => {
    expect(problem(address)).toBeNull();
  });
});

describe("other shielded forms", () => {
  it("accepts a Sapling address, because it is shielded and spendable", () => {
    // Byte issues unified addresses, but refusing Sapling would be the page inventing a
    // restriction the protocol does not have.
    expect(ok("zs1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(3))).toBe(true);
    expect(ok("ztestsapling1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(3))).toBe(true);
  });
});

describe("transparent addresses get their own refusal", () => {
  // Not a typo but a different and worse idea, so it earns a different message: sending
  // there publishes the amount.
  it.each([
    "t1PZUbbgnQiFeLFPsxgVRTMwaKVAaKmFYCH",
    "t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd",
  ])("refuses %s and says why", (address) => {
    const message = problem(address);
    expect(message).not.toBeNull();
    expect(message).toMatch(/transparent/i);
    expect(message).toMatch(/publish/i);
  });
});

describe("what used to slip through", () => {
  it('refuses "not-an-address", which the builder accepted', () => {
    expect(problem("not-an-address")).not.toBeNull();
  });

  it.each([
    ["an empty field", ""],
    ["a bare word", "hello"],
    ["an email address", "someone@example.com"],
    ["a URL", "https://example.com/pay"],
    ["a bitcoin address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"],
    ["an ethereum address", "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"],
    ["the right prefix and nothing else", "u1"],
    ["a unified address that is far too short", "u1qpzry9x8gf"],
    ["characters bech32 does not use", "u1bbbiiioooqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0"],
    ["an address with a space in it", "u1qpzry9x8gf2tvdw0s3jn54khce6mua7l qpzry9x8gf2tvdw0s3jn5"],
  ])("refuses %s", (_label, address) => {
    expect(problem(address)).not.toBeNull();
  });

  it("gives a message that names what a good address looks like", () => {
    const message = problem("not-an-address") ?? "";
    expect(message).toMatch(/u1/);
    expect(message).toMatch(/utest1/);
  });
});
