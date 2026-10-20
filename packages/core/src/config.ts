import { z } from "zod";
import type { EffectKind } from "./types";

export type RuleLevel = "error" | "warning" | "info" | "off";

export interface EffectConfigEntry {
  /** `module` is a package name, an import specifier ("@/lib/billing"), or a project path ("src/lib/billing"). */
  match: { module: string | string[]; callee: string };
  kind: EffectKind;
  idempotent: boolean | "unknown";
  /** Where the call accepts an idempotency key, e.g. { arg: 1, field: "idempotencyKey" }. */
  acceptsKey?: { arg: number; field: string };
}

export interface GuardConfigEntry {
  /** Callee text, e.g. "withIdempotency" or "dedupe.once". */
  callee: string;
  /** Argument holding the dedupe key (default 0). */
  keyArg?: number;
  /** Whether the helper is atomic (default true). */
  atomic?: boolean;
}

export interface RetrysafeConfig {
  /** Globs (relative to the project root) of files to discover handlers in. Default: everything. */
  include?: string[];
  /** Globs to skip during discovery. Default: test files. */
  exclude?: string[];
  handlers?: {
    /** Auto-discover handlers (default true). */
    discover?: boolean;
    /** Force-mark functions as at-least-once: "src/jobs/send-invoice.ts#handler" ("#default" for default exports). */
    add?: string[];
    /** File globs or exact handler names ("POST /api/health") to skip. */
    ignore?: string[];
    /** Handlers that never run concurrently (single-worker queue, external lock). Race rules skip them. */
    serialized?: string[];
    /** Also analyze Next.js server actions (double submits and client retries repeat them). Default false. */
    serverActions?: boolean;
  };
  /** Your own dedupe helpers. */
  guards?: GuardConfigEntry[];
  effects?: { extend?: EffectConfigEntry[] };
  /** Per-provider facts; check the provider's docs. */
  providers?: Record<string, { retryWindowHours?: number }>;
  analysis?: { maxCallDepth?: number; minConfidence?: "low" | "medium" | "high" };
  /** Baseline file path, relative to the root (default ".retrysafe-baseline.json"). */
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

/** Validate a loaded config object; throws ConfigError with readable messages. */
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

/** Identity helper so config files get type checking. */
export function defineConfig(config: RetrysafeConfig): RetrysafeConfig {
  return config;
}
