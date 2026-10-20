import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The CLI imports the workspace core package by name.
    alias: { "@retrysafe/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
