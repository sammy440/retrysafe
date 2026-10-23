import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node20",
    platform: "node",
    clean: true,
    noExternal: ["@retrysafe/core"],
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: ["src/config.ts", "src/core.ts"],
    format: ["esm", "cjs"],
    target: "node20",
    platform: "node",
    noExternal: ["@retrysafe/core"],
  },
]);
