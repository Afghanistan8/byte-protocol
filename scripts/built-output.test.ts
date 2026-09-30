/**
 * The built packages, checked as published rather than as written.
 *
 * ## Why this exists
 *
 * Everything else in this repository is tested through vitest, which resolves
 * `@byte-protocol/*` to each package's **source** (see the aliases in `vitest.config.ts`,
 * and the reason they are there). That is the right default: it keeps a change in one
 * package from appearing to have no effect on another until someone remembers to rebuild.
 *
 * The cost is that nothing ever loaded `dist/`. So `packages/stores` shipped a build whose
 * first line was `import { DatabaseSync } from "sqlite"` — tsup 8 strips the `node:` prefix
 * by default — and `node:sqlite` has no bare alias, so anyone importing the built package
 * got `ERR_MODULE_NOT_FOUND` immediately. Every test passed. It was found by running a
 * script against the built output, which is to say by accident.
 *
 * This file closes that gap the cheap way: it reads the emitted files and asserts the
 * property that was violated, rather than spawning a process per package.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Node built-ins that are importable **only** with the `node:` prefix, so stripping it
 * produces a specifier that does not resolve to anything. These are the ones that turn a
 * cosmetic rewrite into a package that cannot be loaded.
 */
const PREFIX_ONLY = ["sqlite", "test", "sea"];

/**
 * Built-ins that also resolve without the prefix. Importing them bare still works, so this
 * is a correctness point rather than a crash: a bare `fs` can be shadowed by a package
 * called `fs` in a consumer's tree, which is exactly the ambiguity the prefix removes.
 */
const ALSO_BARE = ["fs", "path", "http", "https", "crypto", "url", "os", "events", "buffer"];

const built = globSync("packages/**/dist/index.{js,cjs}", { cwd: ROOT }).map((relative) => ({
  relative: relative.replace(/\\/g, "/"),
  text: readFileSync(new URL(relative.replace(/\\/g, "/"), new URL("./", import.meta.url).href.replace(/scripts\/$/, "")), "utf8"),
}));

/** Every module specifier the file imports or requires. */
function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?:from\s*|import\s*|require\()\s*["']([^"']+)["']/g)) {
    found.push(m[1] as string);
  }
  return found;
}

describe("the built packages", () => {
  it("were actually built, so this file is testing something", () => {
    // A green run over zero files would be the worst possible outcome here: silence that
    // looks like success. `pnpm build` must have run.
    expect(built.length).toBeGreaterThan(0);
    expect(built.map((f) => f.relative)).toContain("packages/stores/dist/index.js");
  });

  it.each(PREFIX_ONLY)(
    "never import %s without its node: prefix, which would not resolve at all",
    (name) => {
      for (const file of built) {
        expect(specifiers(file.text), `${file.relative} imports bare "${name}"`).not.toContain(name);
      }
    },
  );

  it.each(ALSO_BARE)("never import %s without its node: prefix", (name) => {
    for (const file of built) {
      expect(specifiers(file.text), `${file.relative} imports bare "${name}"`).not.toContain(name);
    }
  });

  it("keeps the prefix where the source used it", () => {
    const stores = built.find((f) => f.relative === "packages/stores/dist/index.js");
    expect(stores).toBeDefined();
    // The specific regression: the SQLite store's only built-in import.
    expect(specifiers(stores?.text ?? "")).toContain("node:sqlite");
  });
});
