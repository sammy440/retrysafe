import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { RULES, parseConfig, type RetrysafeConfig } from "@retrysafe/core";

export const CONFIG_FILES = [
  "retrysafe.config.ts",
  "retrysafe.config.mts",
  "retrysafe.config.js",
  "retrysafe.config.mjs",
  "retrysafe.config.cjs",
  "retrysafe.config.json",
];

const ruleIds = RULES.map((r) => r.id);

export function findConfig(root: string): string | undefined {
  return CONFIG_FILES.map((f) => path.join(root, f)).find(existsSync);
}

function selfEntry(): string | undefined {
  return ["./config.js", "./config.ts"].map((p) => fileURLToPath(new URL(p, import.meta.url))).find(existsSync);
}

export async function loadConfig(file: string): Promise<RetrysafeConfig> {
  const display = path.basename(file);
  if (file.endsWith(".json")) return parseConfig(JSON.parse(readFileSync(file, "utf8")), display, ruleIds);
  const self = selfEntry();
  const jiti = createJiti(import.meta.url, { interopDefault: true, alias: self ? { retrysafe: self } : {} });
  const mod = await jiti.import<unknown>(file, { default: true });
  return parseConfig(mod, display, ruleIds);
}
