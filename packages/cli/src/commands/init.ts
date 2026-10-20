import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findConfig } from "../load-config";

function template(frameworks: string[]): string {
  return `import { defineConfig } from "retrysafe";

// Detected: ${frameworks.length ? frameworks.join(", ") : "no known frameworks (handlers can be added below)"}
export default defineConfig({
  // Where to look for webhook routes and queue workers.
  include: ["**/*"],
  exclude: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"],

  handlers: {
    discover: true,
    // Force-mark functions as at-least-once, e.g. a Lambda consumer: "src/jobs/send-invoice.ts#handler"
    add: [],
    // Skip files (globs) or handlers by name, e.g. "POST /api/health"
    ignore: [],
    // Handlers that never run concurrently (single worker, external lock)
    serialized: [],
  },

  // Your own dedupe helpers, e.g. { callee: "withIdempotency", keyArg: 0, atomic: true }
  guards: [],

  effects: {
    // Teach retrysafe about wrappers, e.g.
    // { match: { module: "@/lib/billing", callee: "chargeCustomer" }, kind: "payment", idempotent: false }
    extend: [],
  },

  analysis: { maxCallDepth: 6, minConfidence: "medium" },

  baseline: ".retrysafe-baseline.json",

  rules: {
    // "unguarded-side-effect": "error",
    // "effect-missing-idempotency-key": "off",
  },
});
`;
}

export function detectFrameworks(root: string): string[] {
  const pkgPath = path.join(root, "package.json");
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return ["express", "fastify", "next", "bullmq", "bull", "@aws-sdk/client-sqs", "stripe", "@prisma/client"].filter((d) => d in deps);
}

export function runInit(root: string): number {
  const existing = findConfig(root);
  if (existing) {
    process.stderr.write(`retrysafe: config already exists: ${path.relative(process.cwd(), existing)}\n`);
    return 1;
  }
  const file = path.join(root, "retrysafe.config.ts");
  writeFileSync(file, template(detectFrameworks(root)));
  process.stdout.write(`Created ${path.relative(process.cwd(), file) || file}\n`);
  return 0;
}
