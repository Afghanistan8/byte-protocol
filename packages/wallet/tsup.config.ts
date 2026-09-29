import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // Declarations come from `tsc --build`; see tsconfig.json for why.
  dts: false,
  sourcemap: true,
  // tsc writes .d.ts into the same directory, so tsup must not wipe it.
  clean: false,
  target: "es2022",
  external: ["@byte-protocol/core"],
});
