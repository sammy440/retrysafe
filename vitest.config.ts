import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@retrysafe/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
