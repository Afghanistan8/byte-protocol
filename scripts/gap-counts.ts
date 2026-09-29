/**
 * Count the statuses in docs/GAP_AUDIT.md and write the total back into it.
 *
 * The audit's headline numbers used to be typed by hand, which is precisely how the test
 * counts went stale. They are computed from the rows instead, and
 * `stats-consistency.test.ts` fails if the block disagrees with the rows beneath it.
 *
 * Run with `pnpm gap-counts`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATH = join(root, "docs", "GAP_AUDIT.md");

export const STATUSES = ["Done", "Partial", "Missing", "Not feasible yet"] as const;
export type Status = (typeof STATUSES)[number];

export const BLOCK = /<!--gap-counts-->[\s\S]*?<!--\/gap-counts-->/;

/**
 * Count every table cell that *begins* with a status token.
 *
 * Begins, not equals: some cells read "`Partial` (`byte_fetch_paid`)". Every cell counts
 * because the adapter matrix has one sub-item per cell, not one per row.
 */
export function countStatuses(markdown: string): Record<Status, number> {
  const counts: Record<Status, number> = {
    Done: 0,
    Partial: 0,
    Missing: 0,
    "Not feasible yet": 0,
  };

  // Ignore the block being maintained, or the counts would count themselves.
  const body = markdown.replace(BLOCK, "");

  for (const line of body.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    for (const cell of line.split("|")) {
      const match = /^\s*`(Done|Partial|Missing|Not feasible yet)`/.exec(cell);
      if (match !== null) counts[match[1] as Status] += 1;
    }
  }
  return counts;
}

export function renderBlock(counts: Record<Status, number>): string {
  const total = STATUSES.reduce((sum, status) => sum + counts[status], 0);
  return [
    "<!--gap-counts-->",
    "| Status | Count |",
    "|--------|------:|",
    ...STATUSES.map((status) => `| \`${status}\` | ${counts[status]} |`),
    `| **Total sub-items** | **${total}** |`,
    "<!--/gap-counts-->",
  ].join("\n");
}

function main(): void {
  const before = readFileSync(PATH, "utf8");
  const counts = countStatuses(before);
  const after = before.replace(BLOCK, renderBlock(counts));
  if (after !== before) writeFileSync(PATH, after, "utf8");

  const line = STATUSES.map((s) => `${s} ${counts[s]}`).join(" · ");
  process.stdout.write(`${line}\n${after !== before ? "updated" : "already current"} docs/GAP_AUDIT.md\n`);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("gap-counts.ts")) main();
