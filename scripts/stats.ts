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
  typescript: { files: number; tests: number };
  rust: { tests: number };
  /** The number a human should quote. */
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

function countTypescript(): Stats["typescript"] {
  // BYTE_STATS_REFRESH tells the consistency test not to compare surfaces to STATS.json
  // during this run. Without it the command that fixes a stale surface could never start:
  // the stale surface fails the suite, and a failing suite refuses to write the counts.
  // The next ordinary `vitest run` does the comparison.
  const output = runVitest();

  // "Test Files  25 passed (25)" / "Tests  503 passed (503)"
  const files = /Test Files\s+(\d+) passed \((\d+)\)/.exec(output);
  const tests = /Tests\s+(\d+) passed \((\d+)\)/.exec(output);

  if (files === null || tests === null) {
    throw new Error(`could not find a passing summary in vitest output:\n${output.slice(-2000)}`);
  }
  // A run where passed < total means something failed or was skipped. Recording the
  // passing count alone would quietly overstate the suite.
  if (files[1] !== files[2] || tests[1] !== tests[2]) {
    throw new Error(`not every test passed: ${files[0]}, ${tests[0]}`);
  }

  return { files: Number(files[1]), tests: Number(tests[1]) };
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
