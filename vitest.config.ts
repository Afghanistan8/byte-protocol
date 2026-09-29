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
      "@byte-protocol/stores": src("stores"),
      "@byte-protocol/server": src("server"),
      "@byte-protocol/client": src("client"),
      "@byte-protocol/pricing": src("pricing"),
      "@byte-protocol/registry": src("registry"),
      "@byte-protocol/facilitator": src("facilitator"),
      "@byte-protocol/adapter-x402": fileURLToPath(new URL("./packages/adapters/x402/src/index.ts", import.meta.url)),
      "@byte-protocol/adapter-mcp": fileURLToPath(new URL("./packages/adapters/mcp/src/index.ts", import.meta.url)),
      "@byte-protocol/adapter-a2a-ap2": fileURLToPath(new URL("./packages/adapters/a2a-ap2/src/index.ts", import.meta.url)),
      "@byte-protocol/adapter-langchain": fileURLToPath(new URL("./packages/adapters/langchain/src/index.ts", import.meta.url)),
      "@byte-protocol/console": src("console"),
      "@byte-protocol/rails": fileURLToPath(new URL("./packages/rails/interface/src/index.ts", import.meta.url)),
      "@byte-protocol/rail-near-intents": fileURLToPath(new URL("./packages/rails/near-intents/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: [
      "packages/**/src/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    environment: "node",
    reporters: ["default"],
  },
});
