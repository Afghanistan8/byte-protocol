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
