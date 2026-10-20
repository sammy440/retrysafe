import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  // Bundle the workspace core package; keep real npm deps external.
  noExternal: ["@retrysafe/core"],
  banner: { js: "#!/usr/bin/env node" },
});
