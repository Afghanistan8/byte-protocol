import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // Declarations come from `tsc --build`; see tsconfig.json for why.
  dts: false,
  sourcemap: true,
  clean: false,
  target: "es2022",
  // Keep the `node:` prefix on built-in imports.
  //
  // tsup 8 strips it by default, so `node:sqlite` is emitted as `sqlite`. For `fs` and
  // `http` that is merely wrong, since the bare names still resolve. `node:sqlite` has no
  // bare alias, so the built package threw ERR_MODULE_NOT_FOUND the moment anything
  // imported it — which nothing in CI did, because vitest resolves these packages to
  // their source and never loads dist at all. Found by running a script against the
  // built output. tsup 9 flips this default; setting it explicitly survives that.
  removeNodeProtocol: false,
  external: ["@byte-protocol/core"],
});
