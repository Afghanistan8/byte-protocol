/**
 * Count what actually passes, and write it down.
 *
 * Every surface that quotes a test count — README, the site, the consistency audit — reads
 * from `docs/STATS.json` rather than carrying a number someone typed. The numbers drifted
 * once already: README and both site pages claimed "424 tests, 368 TypeScript, 56 Rust"
 * for weeks after the real figures had moved past 500, because a count in prose has no
 * way of noticing that it is stale.
 *
 * Run it with `pnpm stats`. It runs both suites for real and refuses to write anything if
 * either fails, so the file can never record a count from a red run.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Stats {
  /** RFC 3339 UTC, when this was measured. */
  measuredAt: string;
  typescript: {
    files: number;
    /** Tests that ran and passed. Skipped ones are counted separately, never here. */
    tests: number;
    /**
     * Tests that did not run, such as the live rail test without `BYTE_RAILS_LIVE=1`.
     *
     * Counted apart because a skipped test proves nothing, and folding it into the total
     * would inflate the number Byte quotes with work that never happened.
     */
    skipped: number;
  };
  rust: { tests: number };
  /** The number a human should quote: passing tests only. */
  total: number;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): string {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      encoding: "utf8",
      // Both suites write their summaries to stderr as well as stdout depending on the
      // reporter, so both are captured and searched.
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    throw new Error(
      `${command} ${args.join(" ")} exited ${e.status ?? "abnormally"}:\n${output.slice(-3000)}`,
    );
  }
}

/**
 * Run the suite, retrying once if — and only if — the *runner* died.
 *
 * On Windows a vitest worker occasionally exits with 0xC0000409 (3221226505), a native
 * fail-fast, most often in a file that opens real HTTP servers. It happens in roughly one
 * run in six to twelve, it is not a test failing, and I do not have a root cause. Left
 * alone it made the stats command fail for reasons unrelated to any test.
 *
 * The retry is narrow on purpose. It triggers only on that runner-death signature, never
 * on a failed assertion, so it cannot turn a red suite green. And it says that it retried,
 * so a crash cannot pass unnoticed.
 */
function runVitest(): string {
  const RUNNER_DIED = /Worker exited unexpectedly|Worker forks emitted error/;

  for (let attempt = 1; ; attempt++) {
    try {
      return run("npx", ["vitest", "run"], { env: { BYTE_STATS_REFRESH: "1" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed test prints a FAIL line; a dead runner does not. Both must hold to retry.
      const runnerDied = RUNNER_DIED.test(message) && !/\bFAIL\b/.test(message);
      if (!runnerDied || attempt >= 2) throw error;
      process.stderr.write("vitest's worker process died (not a test failure); retrying once\n");
    }
  }
}

/**
 * Pull the counts out of vitest's summary.
 *
 * Exported so it can be tested against the shapes vitest actually emits without running the
 * suite. It decides the number Byte publishes, so its failure modes matter more than its
 * happy path.
 *
 * Vitest's summary gains segments as a run acquires skips or failures:
 *
 * ```
 * Test Files  29 passed (29)
 * Tests  598 passed | 5 skipped (603)
 * Tests  1 failed | 530 passed (531)
 * ```
 *
 * Parsed segment by segment rather than by one fixed shape. The first version matched only
 * `N passed (N)` and broke the moment the live rail test started skipping itself, which is a
 * normal state for this suite and not a failure.
 */
export function parseVitestSummary(output: string): Stats["typescript"] {
  const files = /Test Files\s+(\d+) passed \((\d+)\)/.exec(output);
  const testsLine = /^\s*Tests\s+(.+?)\s*$/m.exec(output);

  if (files === null || testsLine === null) {
    throw new Error(`could not find a test summary in vitest output:\n${output.slice(-2000)}`);
  }

  const summary = testsLine[1] as string;
  const segment = (name: string): number => {
    const found = new RegExp(`(\\d+) ${name}`).exec(summary);
    return found === null ? 0 : Number(found[1]);
  };

  const passed = segment("passed");
  const skipped = segment("skipped");
  const failed = segment("failed");
  const todo = segment("todo");
  const total = Number(/\((\d+)\)\s*$/.exec(summary)?.[1] ?? "0");

  if (failed > 0) throw new Error(`not every test passed: Tests ${summary}`);

  // Every test must be accounted for. This is the check that matters: a segment this parser
  // does not know about would otherwise vanish from the count Byte publishes, silently.
  if (passed + skipped + todo !== total) {
    throw new Error(
      `could not account for every test (${passed} passed + ${skipped} skipped + ` +
        `${todo} todo != ${total}): Tests ${summary}`,
    );
  }

  // An import-time crash fails a file without failing a test, so files are checked too.
  if (files[1] !== files[2]) {
    throw new Error(`not every test file passed: ${files[0]}`);
  }

  // `tests` is passing tests only. A skipped test proves nothing, and counting it would
  // inflate the number Byte quotes with work that never ran.
  return { files: Number(files[1]), tests: passed, skipped };
}

function countTypescript(): Stats["typescript"] {
  // BYTE_STATS_REFRESH tells the consistency test not to compare surfaces to STATS.json
  // during this run. Without it the command that fixes a stale surface could never start:
  // the stale surface fails the suite, and a failing suite refuses to write the counts.
  // The next ordinary `vitest run` does the comparison.
  return parseVitestSummary(runVitest());
}

function countRust(): Stats["rust"] {
  const output = run("cargo", ["test", "--lib"], { cwd: join(root, "crates", "byte-walletd") });

  // "test result: ok. 60 passed; 0 failed; ..." — sum across binaries, and insist none failed.
  const results = [...output.matchAll(/test result: ok\. (\d+) passed; (\d+) failed/g)];
  if (results.length === 0) {
    throw new Error(`could not find a test result in cargo output:\n${output.slice(-2000)}`);
  }

  let passed = 0;
  for (const result of results) {
    if (result[2] !== "0") throw new Error(`cargo reported failures: ${result[0]}`);
    passed += Number(result[1]);
  }
  return { tests: passed };
}

/**
 * Every file that quotes a count, wrapped in markers so it can be rewritten in place:
 * `<!--stats:total-->563<!--/stats-->`. HTML comments render as nothing in both HTML and
 * GitHub-flavoured Markdown, so the marker costs a reader nothing.
 */
export const STAT_SURFACES = [
  "README.md",
  "apps/site/index.html",
  "docs/CONSISTENCY_AUDIT.md",
] as const;

export const STAT_MARKER = /<!--stats:(total|ts|rust)-->(\d+)<!--\/stats-->/g;

export function statValue(stats: Stats, key: string): number {
  if (key === "total") return stats.total;
  if (key === "ts") return stats.typescript.tests;
  if (key === "rust") return stats.rust.tests;
  throw new Error(`unknown stat marker ${key}`);
}

/** Rewrite every marker in every surface. Returns the files it changed. */
function updateSurfaces(stats: Stats): string[] {
  const changed: string[] = [];
  for (const relative of STAT_SURFACES) {
    const path = join(root, relative);
    const before = readFileSync(path, "utf8");
    const after = before.replace(
      STAT_MARKER,
      (_match, key: string) => `<!--stats:${key}-->${statValue(stats, key)}<!--/stats-->`,
    );
    if (after !== before) {
      writeFileSync(path, after, "utf8");
      changed.push(relative);
    }
  }
  return changed;
}

function main(): void {
  process.stdout.write("counting TypeScript tests…\n");
  const typescript = countTypescript();

  process.stdout.write("counting Rust tests…\n");
  const rust = countRust();

  const stats: Stats = {
    measuredAt: new Date().toISOString(),
    typescript,
    rust,
    total: typescript.tests + rust.tests,
  };

  const path = join(root, "docs", "STATS.json");
  writeFileSync(path, `${JSON.stringify(stats, null, 2)}\n`, "utf8");

  const changed = updateSurfaces(stats);

  const summary = [
    "",
    `${stats.total} tests: ${typescript.tests} TypeScript across ${typescript.files} files, ${rust.tests} Rust.`,
    "written to docs/STATS.json",
    changed.length > 0 ? `updated: ${changed.join(", ")}` : "surfaces already current",
    "",
  ];
  process.stdout.write(summary.join("\n"));
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("stats.ts")) main();
