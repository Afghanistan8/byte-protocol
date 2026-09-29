import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Resolve workspace packages to their source, not their built output. Without this a
  // test run silently exercises whatever dist/ happened to be built last, so a change to
  // one package appears to have no effect on another until someone remembers to rebuild.
  // The build is still verified separately, by `pnpm build` in CI.
  resolve: {
    alias: {
      "@byte-protocol/core": src("core"),
      "@byte-protocol/wallet": src("wallet"),
    },
  },
  test: {
    include: ["packages/**/src/**/*.test.ts", "packages/**/test/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
