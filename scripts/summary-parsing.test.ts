/**
 * The vitest summary parser, exercised against the shapes vitest actually emits.
 *
 * This exists because the first version matched only `Tests  N passed (N)` and broke the
 * moment the live rail test began skipping itself. That is a normal state for this suite,
 * not a failure, and `pnpm stats` died on it.
 *
 * The parser decides the number Byte publishes, so its failure modes matter more than its
 * happy path: it must refuse a run with failures, and refuse a summary it cannot fully
 * account for rather than quietly dropping a segment it does not recognise.
 */

import { describe, expect, it } from "vitest";
import { parseVitestSummary } from "./stats.js";

const files = (n: number) => `\n Test Files  ${n} passed (${n})\n`;

describe("a clean run", () => {
  it("counts passing tests", () => {
    const parsed = parseVitestSummary(`${files(29)} Tests  598 passed (598)\n`);
    expect(parsed).toEqual({ files: 29, tests: 598, skipped: 0 });
  });
});

describe("a run with skips", () => {
  it("counts them separately and never in the total Byte quotes", () => {
    // A skipped test proves nothing. Counting it would inflate the published number with
    // work that never ran.
    const parsed = parseVitestSummary(`${files(29)} Tests  598 passed | 5 skipped (603)\n`);
    expect(parsed).toEqual({ files: 29, tests: 598, skipped: 5 });
  });

  it("handles the segments in either order", () => {
    const parsed = parseVitestSummary(`${files(29)} Tests  5 skipped | 598 passed (603)\n`);
    expect(parsed.tests).toBe(598);
    expect(parsed.skipped).toBe(5);
  });

  it("counts todo tests towards the total without publishing them", () => {
    const parsed = parseVitestSummary(`${files(29)} Tests  598 passed | 2 todo (600)\n`);
    expect(parsed.tests).toBe(598);
  });
});

describe("what it refuses", () => {
  it("refuses a run with any failure", () => {
    expect(() =>
      parseVitestSummary(`${files(29)} Tests  1 failed | 530 passed (531)\n`),
    ).toThrow(/not every test passed/);
  });

  it("refuses a run where a test file failed, even if every test passed", () => {
    // An import-time crash fails a file without failing a test.
    expect(() =>
      parseVitestSummary("\n Test Files  25 passed (26)\n Tests  530 passed (530)\n"),
    ).toThrow(/not every test file passed/);
  });

  it("refuses a summary it cannot fully account for", () => {
    // The real risk: a segment this parser does not know about would otherwise vanish from
    // the count silently. Better to fail and be told than to publish a wrong number.
    expect(() =>
      parseVitestSummary(`${files(29)} Tests  598 passed | 4 quarantined (602)\n`),
    ).toThrow(/could not account for every test/);
  });

  it("refuses output with no summary at all", () => {
    expect(() => parseVitestSummary("the runner died before reporting")).toThrow(
      /could not find a test summary/,
    );
  });
});
