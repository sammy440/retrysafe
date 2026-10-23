import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const typesDir = new URL("../dist/types/", import.meta.url);
for (const f of readdirSync(typesDir, { recursive: true }).filter((f) => f.endsWith(".d.ts"))) {
  const file = new URL(f, typesDir);
  const ext = (p) => (p.endsWith(".js") ? p : existsSync(new URL(`${p}/index.d.ts`, file)) ? `${p}/index.js` : `${p}.js`);
  writeFileSync(file, readFileSync(file, "utf8").replace(/(from\s+["'])(\.\.?\/[^"']+?)(["'])/g, (m, a, p, b) => `${a}${ext(p)}${b}`));
}

const body = `export { defineConfig } from "./types/config.js";
export type { EffectConfigEntry, GuardConfigEntry, RetrysafeConfig, RuleLevel } from "./types/config.js";
`;
writeFileSync(new URL("../dist/config.d.ts", import.meta.url), body);
writeFileSync(new URL("../dist/config.d.cts", import.meta.url), body);

const core = `export { analyze, RULES } from "./types/index.js";
export type * from "./types/index.js";
`;
writeFileSync(new URL("../dist/core.d.ts", import.meta.url), core);
writeFileSync(new URL("../dist/core.d.cts", import.meta.url), core);
