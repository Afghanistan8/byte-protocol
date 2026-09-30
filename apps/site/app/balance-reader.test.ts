/**
 * The dashboard's balance reader, tested against the shapes a wallet actually sends.
 *
 * ## Why this file exists
 *
 * The dashboard is a single hand-written HTML page with no build step, which is the right
 * shape for something a reader should be able to open and audit in one sitting. The cost is
 * that its JavaScript had no tests, and the balance reader is the part of it that most
 * deserves them: it turns a wallet's reply into a number people read as their money.
 *
 * It has already been wrong twice. It read only the top level of the reply, so a wallet
 * that nests its figures under an account or under the asset produced a confident `0`
 * beside a wallet plainly showing a balance. Then, once the reader learned to walk the
 * reply, it matched key names against a fixed list of spellings and missed
 * `shieldedZatoshis` by one word.
 *
 * Rather than duplicate the functions here, where a copy would drift from the page and
 * pass while the page failed, this extracts them from `index.html` and runs the real
 * source. If someone edits the page and breaks the reader, this goes red.
 *
 * ## What is not covered
 *
 * Only the pure parts: finding a field, and converting it. Everything touching the DOM or
 * the wallet provider is left to the browser, so a green run here does not mean the page
 * renders correctly.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PAGE = fileURLToPath(new URL("./index.html", import.meta.url));

interface Found {
  key: string;
  value: string | number;
}

interface Reader {
  findBalanceField: (value: unknown, names: string[], depth: number) => Found | null;
  amountToZat: (found: Found | null) => string | null;
  normalizeKey: (key: string) => string;
  SHIELDED_KEYS: string[];
  TRANSPARENT_KEYS: string[];
  TOTAL_KEYS: string[];
}

/**
 * Pull the reader out of the page.
 *
 * The slices are taken between named landmarks rather than by line number, so ordinary
 * edits above or below them do not silently change what is under test. A landmark that
 * stops matching throws here rather than quietly testing an empty string.
 */
function loadReader(): Reader {
  const html = readFileSync(PAGE, "utf8").replace(/\r\n/g, "\n");

  const between = (open: string, close: string): string => {
    const a = html.indexOf(open);
    if (a < 0) throw new Error(`landmark missing from index.html: ${open}`);
    const b = html.indexOf(close, a);
    if (b < 0) throw new Error(`landmark missing from index.html: ${close}`);
    return html.slice(a, b);
  };

  const body = between("  var NOT_ZEC =", "  function refreshNoir()");
  const zecToZat = between("  function zecToZat(value) {", "\n  }\n") + "\n  }\n";

  return new Function(
    `${body}\n${zecToZat}\nreturn { findBalanceField, amountToZat, normalizeKey,` +
      " SHIELDED_KEYS, TRANSPARENT_KEYS, TOTAL_KEYS };",
  )() as Reader;
}

const reader = loadReader();
const read = (reply: unknown, names: string[]): string | null =>
  reader.amountToZat(reader.findBalanceField(reply, names, 0));
const shielded = (reply: unknown): string | null => read(reply, reader.SHIELDED_KEYS);
const transparent = (reply: unknown): string | null => read(reply, reader.TRANSPARENT_KEYS);
const total = (reply: unknown): string | null => read(reply, reader.TOTAL_KEYS);

describe("the shape the reader already handled", () => {
  it("reads decimal ZEC strings at the top level", () => {
    const reply = { spendable: "1.0", transparent: "0.5", total: "1.5" };
    expect(shielded(reply)).toBe("100000000");
    expect(transparent(reply)).toBe("50000000");
    expect(total(reply)).toBe("150000000");
  });

  it("reads numbers as well as strings, without losing small amounts to exponents", () => {
    expect(shielded({ shielded: 1 })).toBe("100000000");
    // 1e-7 stringifies as "1e-7", which the converter would reject. It must not.
    expect(shielded({ shielded: 1e-7 })).toBe("10");
  });
});

describe("units are decided by the key name, never by the size of the number", () => {
  it("passes a zatoshi-named field through unscaled", () => {
    expect(shielded({ spendableZat: "100000000" })).toBe("100000000");
    expect(shielded({ shieldedZatoshis: 12345 })).toBe("12345");
    expect(transparent({ transparentZatoshis: "500" })).toBe("500");
  });

  it("scales a ZEC-named field, even when it looks like a zatoshi count", () => {
    // 100000000 under a plain `shielded` key means 100 million ZEC, not one ZEC. Guessing
    // the unit from magnitude would be the kind of cleverness that misreports money.
    expect(shielded({ shielded: "100000000" })).toBe("10000000000000000");
  });

  it("treats every spelling of one name as that name", () => {
    for (const key of ["shielded", "shieldedBalance", "spendable", "available"]) {
      expect(shielded({ [key]: "0.09975" })).toBe("9975000");
    }
    for (const key of ["shieldedZat", "shielded_zatoshis", "ShieldedZatoshi", "spendableZats"]) {
      expect(shielded({ [key]: "9975000" })).toBe("9975000");
    }
  });

  it("does not fold a name away to nothing", () => {
    // "balance" normalizes to itself, not to "", so it stays a total and never a shielded
    // figure. Stripping the suffix unconditionally would make every total look spendable.
    expect(reader.normalizeKey("balance")).toBe("balance");
    expect(reader.normalizeKey("zat")).toBe("zat");
    expect(shielded({ balance: "1.0" })).toBeNull();
    expect(total({ balance: "1.0" })).toBe("100000000");
  });
});

describe("figures nested anywhere in the reply", () => {
  it("finds them under the asset", () => {
    expect(shielded({ zec: { spendable: "1.0" } })).toBe("100000000");
    expect(shielded({ balances: { zec: { shieldedZat: "99750000" } } })).toBe("99750000");
  });

  it("finds them under an account, including a list of accounts", () => {
    expect(shielded({ accounts: [{ index: 0, shielded: "0.09975" }] })).toBe("9975000");
    expect(shielded([{ account: 1, spendable: "1.0" }])).toBe("100000000");
  });

  it("prefers a field at the current level over one nested below it", () => {
    expect(shielded({ spendable: "2.0", sub: { spendable: "1.0" } })).toBe("200000000");
  });
});

describe("a multi-asset wallet", () => {
  // Noir reports ZEC beside BTC and ETH in one reply. Reading a BTC figure as a ZEC
  // balance would tell someone they can spend money they do not have.
  const multi = {
    btc: { spendable: "0.4" },
    eth: { spendable: "12" },
    zec: { spendable: "1.0" },
  };

  it("reads the ZEC figure and not another asset's", () => {
    expect(shielded(multi)).toBe("100000000");
  });

  it("reads nothing at all rather than the wrong asset", () => {
    expect(shielded({ btc: { spendable: "0.4" } })).toBeNull();
    expect(shielded({ ethereum: { shielded: "3" } })).toBeNull();
  });
});

describe("when nothing can be read", () => {
  // Every one of these must be null, not "0". The page prints null as an em dash and shows
  // the wallet's raw reply; it prints "0" as a balance. Saying "you have nothing" when the
  // truth is "I could not tell" is the bug this whole file exists to prevent.
  it.each([
    ["an empty object", {}],
    ["null", null],
    ["a string", "hello"],
    ["an unknown shape", { walletBalanceSummary: { foo: 1 } }],
    ["an empty string value", { shielded: "" }],
    ["a non-numeric value", { shielded: "abc" }],
    ["a negative number", { shielded: -1 }],
    ["a malformed zatoshi count", { shieldedZat: "12.5" }],
    ["NaN", { shielded: Number.NaN }],
    ["Infinity", { shielded: Number.POSITIVE_INFINITY }],
  ])("returns null for %s", (_label, reply) => {
    expect(shielded(reply)).toBeNull();
  });
});

describe("hostile or awkward replies", () => {
  it("terminates on a reply that contains itself", () => {
    const cycle: Record<string, unknown> = { a: {} };
    (cycle.a as Record<string, unknown>).self = cycle;
    expect(shielded(cycle)).toBeNull();
  });

  it("stops descending rather than walking an arbitrarily deep reply", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { spendable: "1" } } } } } } } };
    expect(shielded(deep)).toBeNull();
  });

  it("still finds a figure within the depth it does search", () => {
    expect(shielded({ a: { b: { c: { spendable: "1.0" } } } })).toBe("100000000");
  });
});
