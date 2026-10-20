// Public type entry for `import { defineConfig } from "retrysafe"`, re-exporting the emitted core config types.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

// NodeNext consumers need explicit extensions on relative imports in .d.ts files.
const typesDir = new URL("../dist/types/", import.meta.url);
for (const f of readdirSync(typesDir).filter((f) => f.endsWith(".d.ts"))) {
  const file = new URL(f, typesDir);
  writeFileSync(file, readFileSync(file, "utf8").replace(/(from\s+["'])(\.\.?\/[^"']+?)(["'])/g, (m, a, p, b) => (p.endsWith(".js") ? m : `${a}${p}.js${b}`)));
}

const body = `export { defineConfig } from "./types/config.js";
export type { EffectConfigEntry, GuardConfigEntry, RetrysafeConfig, RuleLevel } from "./types/config.js";
`;
writeFileSync(new URL("../dist/config.d.ts", import.meta.url), body);
writeFileSync(new URL("../dist/config.d.cts", import.meta.url), body);
