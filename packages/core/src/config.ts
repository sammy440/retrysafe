import { z } from "zod";
import type { EffectKind } from "./types";

export type RuleLevel = "error" | "warning" | "info" | "off";

export interface EffectConfigEntry {
  match: { module: string | string[]; callee: string };
  kind: EffectKind;
  idempotent: boolean | "unknown";
  acceptsKey?: { arg: number; field: string };
}

export interface GuardConfigEntry {
  callee: string;
  keyArg?: number;
  atomic?: boolean;
}

export interface RetrysafeConfig {
  include?: string[];
  exclude?: string[];
  handlers?: {
    discover?: boolean;
    add?: string[];
    ignore?: string[];
    serialized?: string[];
    serverActions?: boolean;
  };
  guards?: GuardConfigEntry[];
  effects?: { extend?: EffectConfigEntry[] };
  providers?: Record<string, { retryWindowHours?: number }>;
  analysis?: { maxCallDepth?: number; minConfidence?: "low" | "medium" | "high" };
  baseline?: string;
  rules?: Record<string, RuleLevel>;
}

const effectKind = z.enum(["db-write", "payment", "email", "sms", "enqueue", "http-call", "file-write", "unknown"]);

export const configSchema = z
  .object({
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    handlers: z
      .object({
        discover: z.boolean().optional(),
        add: z.array(z.string().regex(/#/, 'expected "path/to/file.ts#exportName"')).optional(),
        ignore: z.array(z.string()).optional(),
        serialized: z.array(z.string()).optional(),
        serverActions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    guards: z
      .array(z.object({ callee: z.string().min(1), keyArg: z.number().int().min(0).optional(), atomic: z.boolean().optional() }).strict())
      .optional(),
    effects: z
      .object({
        extend: z
          .array(
            z
              .object({
                match: z.object({ module: z.union([z.string(), z.array(z.string())]), callee: z.string().min(1) }).strict(),
                kind: effectKind,
                idempotent: z.union([z.boolean(), z.literal("unknown")]),
                acceptsKey: z.object({ arg: z.number().int().min(0), field: z.string() }).strict().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    providers: z.record(z.string(), z.object({ retryWindowHours: z.number().positive().optional() }).strict()).optional(),
    analysis: z
      .object({ maxCallDepth: z.number().int().min(0).max(50).optional(), minConfidence: z.enum(["low", "medium", "high"]).optional() })
      .strict()
      .optional(),
    baseline: z.string().optional(),
    rules: z.record(z.string(), z.enum(["error", "warning", "info", "off"])).optional(),
  })
  .strict() satisfies z.ZodType<RetrysafeConfig>;

export class ConfigError extends Error {}

export function parseConfig(input: unknown, source = "config", knownRules?: string[]): RetrysafeConfig {
  const r = configSchema.safeParse(input ?? {});
  const lines = r.success ? [] : r.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
  if (r.success && knownRules) {
    for (const id of Object.keys(r.data.rules ?? {})) {
      if (!knownRules.includes(id)) lines.push(`  rules.${id}: unknown rule (run \`retrysafe rules\` to list them)`);
    }
  }
  if (lines.length || !r.success) throw new ConfigError(`Invalid ${source}:\n${lines.join("\n")}`);
  return r.data;
}

export const DEFAULT_EXCLUDE = ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/__mocks__/**"];
export const DEFAULT_BASELINE = ".retrysafe-baseline.json";

export function defineConfig(config: RetrysafeConfig): RetrysafeConfig {
  return config;
}
