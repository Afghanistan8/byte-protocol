/**
 * Every surface that quotes a test count must agree with `docs/STATS.json`.
 *
 * README and the site both once claimed "424 tests, 368 TypeScript, 56 Rust" for weeks
 * after the real figures had passed 500. A count typed into prose has no way of noticing
 * that it went stale, so counts now live in one file, written by `pnpm stats` from real
 * runs of both suites, and every surface carries them inside markers this test can find.
 *
 * This test does not re-run the suites. It compares what each surface *says* against what
 * was last *measured*, which is the drift that actually happened.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BLOCK, countStatuses, renderBlock } from "./gap-counts.js";
import { STAT_MARKER, STAT_SURFACES, statValue, type Stats } from "./stats.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const stats = JSON.parse(readFileSync(join(root, "docs", "STATS.json"), "utf8")) as Stats;

describe("docs/STATS.json", () => {
  it("is internally consistent", () => {
    expect(stats.total).toBe(stats.typescript.tests + stats.rust.tests);
  });

  it("records real, positive counts", () => {
    expect(stats.typescript.tests).toBeGreaterThan(0);
    expect(stats.rust.tests).toBeGreaterThan(0);
  });
});

describe.each(STAT_SURFACES)("%s", (relative) => {
  const text = readFileSync(join(root, relative), "utf8");
  const markers = [...text.matchAll(new RegExp(STAT_MARKER.source, "g"))];

  it("carries at least one stat marker", () => {
    // Without this, deleting the markers would make every other check vacuously pass and
    // the count could rot again without anything noticing.
    expect(markers.length).toBeGreaterThan(0);
  });

  it("quotes exactly the counts in STATS.json", () => {
    // `pnpm stats` sets this while it measures, so that a stale surface cannot block the
    // command that repairs it. Every other run, including CI and a plain `pnpm test`,
    // compares for real.
    if (process.env.BYTE_STATS_REFRESH === "1") return;

    for (const marker of markers) {
      const key = marker[1] as string;
      expect(Number(marker[2]), `${relative}: ${key}`).toBe(statValue(stats, key));
    }
  });

  it("quotes all three of total, TypeScript and Rust", () => {
    // A surface that gives a total but omits the split, or the reverse, invites someone to
    // "fix" one figure and leave the other.
    const keys = new Set(markers.map((m) => m[1]));
    expect([...keys].sort()).toEqual(["rust", "total", "ts"]);
  });

  it("has no bare count left outside a marker", () => {
    // Strip the markers, then look for the shape of a hand-typed count. A number sitting
    // next to the word "tests" that is not inside a marker is exactly how this drifted.
    const withoutMarkers = text.replace(new RegExp(STAT_MARKER.source, "g"), "");
    expect(withoutMarkers).not.toMatch(/\b\d{3}\s+tests\b/i);
    expect(withoutMarkers).not.toMatch(/\b\d{2,3}\s+(TypeScript|Rust)\b/);
  });
});

describe("docs/GAP_AUDIT.md", () => {
  const audit = readFileSync(join(root, "docs", "GAP_AUDIT.md"), "utf8");

  it("states the status counts its own rows add up to", () => {
    // The headline numbers were originally typed by hand and never matched the rows. They
    // are computed now, and this fails if the block and the rows beneath it disagree.
    const stated = BLOCK.exec(audit)?.[0];
    expect(stated, "the <!--gap-counts--> block is missing").toBeDefined();
    expect(stated).toBe(renderBlock(countStatuses(audit)));
  });

  it("claims Done only where a test is named", () => {
    // A `Done` row with an empty test column is a claim with nothing behind it, which is
    // the one thing this audit exists to prevent. Rows that legitimately have no test
    // (documentation, removed claims) say so in words rather than leaving a dash.
    const offenders: string[] = [];
    for (const line of audit.split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      // | item | status | where | test | missing |  -> cells[0] is the empty lead
      if (cells.length < 6) continue;
      if (!/^`Done`/.test(cells[2] ?? "")) continue;
      const test = cells[4] ?? "";
      if (test === "" || test === "—") offenders.push((cells[1] ?? "").slice(0, 60));
    }
    // Tolerated: documentation-only rows, where "test" would be a category error. Each is
    // listed by name so adding another is a deliberate act rather than drift.
    const documentationOnly = [
      "Documented: no two-transaction window",
      'Documented: no "silent failure" trick needed',
      "Documented: reduces linkability, does not remove it",
      "Documented as facilitator-enforced, not on-chain",
      "README and SPEC state ZEC settlement and price risk",
      "Never described as \"on-chain allowances\"",
      "Other rails Implemented or Planned with reasons",
      "Mock price source",
      "Protocol fee = 0",
    ];
    const unexpected = offenders.filter(
      (o) => !documentationOnly.some((d) => o.startsWith(d.slice(0, 40))),
    );
    expect(unexpected).toEqual([]);
  });
});
