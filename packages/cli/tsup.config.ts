import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node20",
    platform: "node",
    clean: true,
    // Bundle the workspace core package; keep real npm deps external.
    noExternal: ["@retrysafe/core"],
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    // Public library entries: `import { defineConfig } from "retrysafe"` and `retrysafe/core`.
    entry: ["src/config.ts", "src/core.ts"],
    format: ["esm", "cjs"],
    target: "node20",
    platform: "node",
    noExternal: ["@retrysafe/core"],
    // Declarations come from `tsc -p tsconfig.dts.json` (TypeScript 7 has no JS API for dts bundlers).
  },
]);
