export { analyze, analyzeLoaded, discover, discoveryFiles, mergeResults, optionsFromConfig, type AnalyzeOptions } from "./analyze";
export {
  ConfigError,
  DEFAULT_BASELINE,
  DEFAULT_EXCLUDE,
  configSchema,
  defineConfig,
  parseConfig,
  type EffectConfigEntry,
  type GuardConfigEntry,
  type RetrysafeConfig,
  type RuleLevel,
} from "./config";
export { applyBaseline, createBaseline, parseBaseline, staleBaselineEntries, type Baseline, type BaselineEntry } from "./baseline";
export { applyInlineSuppressions } from "./suppress";
export { filterByChangedFiles, handlerFiles } from "./changed";
export { HandlerConfigError } from "./discovery/configured";
export { loadProject, loadProjects, fromProject, type LoadedProject } from "./project/loader";
export { workspacePackages } from "./project/workspace";
export {
  AWS_COMMANDS,
  DEDUPE_NAME,
  EFFECT_CATALOG,
  PACKS,
  PROVIDERS,
  VERIFY_CATALOG,
  chainMatches,
  moduleMatches,
  type EffectCatalogEntry,
  type Pack,
} from "./effects/catalog";
export type { CustomGuard } from "./guards/detect";
export { RULES, type Rule, type RuleDocs, type RuleSetting } from "./rules";
export type * from "./types";
