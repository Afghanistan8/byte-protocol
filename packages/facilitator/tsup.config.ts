import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: false,
  target: "es2022",
  external: ["@byte-protocol/core", "@byte-protocol/wallet", "@byte-protocol/server"],
});
