import path from "node:path";
import picomatch from "picomatch";
import { Node, type Project, type SourceFile } from "ts-morph";
import { Walker, location } from "./analysis/walker";
import { DEFAULT_EXCLUDE, type EffectConfigEntry, type GuardConfigEntry, type RetrysafeConfig } from "./config";
import { PROVIDERS } from "./effects/catalog";
import { discoverConfigured } from "./discovery/configured";
import { discoverExpress } from "./discovery/express";
import { discoverFastify } from "./discovery/fastify";
import { discoverServerActions } from "./discovery/server-actions";
import { discoverServerless } from "./discovery/serverless";
import { discoverNext } from "./discovery/next";
import { discoverProbot } from "./discovery/probot";
import { discoverQueues } from "./discovery/queues";
import { resolveMiddleware, type Candidate } from "./discovery/types";
import { guardLibraryAdapter } from "./guards/detect";
import { fromProject, loadProjects, type LoadedProject } from "./project/loader";
import { runRules, type RuleSetting } from "./rules";
import { fingerprint } from "./rules/shared";
import { findTable, insertProtection, loadSchema, type SchemaFacts } from "./schema";
import { applyInlineSuppressions } from "./suppress";
import type { AnalysisResult, Check, Confidence, Finding, Handler, HandlerReport } from "./types";

export interface AnalyzeOptions {
  /** Directory to analyze. Defaults to the current working directory. */
  root?: string;
  tsconfig?: string;
  /** Analyze an existing ts-morph project (e.g. in-memory, for tests or the playground). */
  project?: Project;
  include?: string[];
  exclude?: string[];
  handlers?: RetrysafeConfig["handlers"];
  maxCallDepth?: number;
  minConfidence?: Confidence;
  guards?: GuardConfigEntry[];
  effects?: EffectConfigEntry[];
  providers?: RetrysafeConfig["providers"];
  rules?: Record<string, RuleSetting>;
}

/** Map a validated config file onto analyzer options. Explicit (non-undefined) overrides win. */
export function optionsFromConfig(config: RetrysafeConfig, overrides: AnalyzeOptions = {}): AnalyzeOptions {
  return {
    include: config.include,
    exclude: config.exclude,
    handlers: config.handlers,
    guards: config.guards,
    effects: config.effects?.extend,
    providers: config.providers,
    rules: config.rules,
    maxCallDepth: config.analysis?.maxCallDepth,
    minConfidence: config.analysis?.minConfidence,
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  };
}

const KNOWN_PROVIDERS = ["stripe", "paystack", "flutterwave", "shopify", "github", "twilio", "sendgrid", "resend", "clerk", "paypal"];
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

const rel = (root: string, sf: SourceFile) => path.relative(root, sf.getFilePath()).split(path.sep).join("/");

/** Source files to discover handlers in (calls are still followed into every project file). */
export function discoveryFiles(loaded: LoadedProject, opts: Pick<AnalyzeOptions, "include" | "exclude">): SourceFile[] {
  const include = opts.include?.length ? picomatch(opts.include, { dot: true }) : () => true;
  const exclude = picomatch(opts.exclude ?? DEFAULT_EXCLUDE, { dot: true });
  return loaded.sourceFiles.filter((sf) => {
    const file = rel(loaded.root, sf);
    return include(file) && !exclude(file);
  });
}

export function discover(loaded: LoadedProject, opts: AnalyzeOptions = {}): Candidate[] {
  const files = discoveryFiles(loaded, opts);
  const auto =
    opts.handlers?.discover === false
      ? []
      : [
          ...discoverExpress(files),
          ...discoverFastify(files),
          ...discoverNext(files, loaded.root),
          ...discoverQueues(files),
          ...discoverServerless(files, loaded.root),
          ...discoverProbot(files),
          ...(opts.handlers?.serverActions ? discoverServerActions(files, loaded.root) : []),
        ];
  const configured = discoverConfigured(loaded, opts.handlers?.add ?? []);
  // A configured entry replaces an auto-discovered one for the same function.
  const forced = new Set(configured.map((c) => c.fn));
  const ignore = opts.handlers?.ignore ?? [];
  const ignoredFile = ignore.length ? picomatch(ignore, { dot: true }) : () => false;
  return [...auto.filter((c) => !forced.has(c.fn)), ...configured].filter(
    (c) => !ignore.includes(c.name) && !ignoredFile(rel(loaded.root, c.anchor.getSourceFile())),
  );
}

/**
 * Decide unique inserts from the schema: a claim is atomic only if a unique constraint covers the inserted
 * columns. A table the schema defines without one cannot stop duplicates, even with ON CONFLICT.
 */
function applySchema(report: HandlerReport, schema: SchemaFacts): void {
  for (const g of report.guards) {
    if (g.kind !== "unique-insert") continue;
    g.schema = insertProtection(schema, g.table, g.columns);
    g.schemaSource = g.table ? findTable(schema, g.table)?.source : undefined;
    if (g.schema === "unique-constraint" && g.atomic === "unknown") g.atomic = true;
    if (g.schema === "no-unique-constraint") g.atomic = false;
  }
}

/** Event types a handler branches on: `event.type === "invoice.paid"`, `case "invoice.paid":`. */
function eventTypes(fn: Node): string[] {
  const text = fn.getText();
  const types = new Set<string>();
  for (const m of text.matchAll(/\.(?:type|event|topic|action)\s*={2,3}\s*["'`]([\w.:/-]+)["'`]/g)) types.add(m[1]!);
  if (/switch\s*\(\s*[\w.]*\.(?:type|event|topic|action)\s*\)/.test(text)) {
    for (const m of text.matchAll(/case\s+["'`]([\w.:/-]+)["'`]\s*:/g)) types.add(m[1]!);
  }
  return [...types];
}

/** Does the handler compare a version, sequence, or timestamp before applying state? */
function checksOrdering(fn: Node): boolean {
  const text = fn.getText();
  const field = "(version|sequence|seq|revision|created|createdAt|created_at|updatedAt|updated_at|occurred_?at|event_?time|timestamp|lastEventAt)";
  return (
    new RegExp(`\\b${field}\\b[^;\\n]{0,60}(<=?|>=?)`, "i").test(text) ||
    new RegExp(`(<=?|>=?)[^;\\n]{0,60}\\b${field}\\b`, "i").test(text) ||
    new RegExp(`\\b(lt|lte|gt|gte|\\$lt|\\$lte|\\$gt|\\$gte)\\s*:[^,}]{0,60}${field}|${field}\\s*:\\s*\\{\\s*\\$?(lt|lte|gt|gte)\\b`, "i").test(text)
  );
}

/** Header names that only webhook deliveries carry (signature and delivery-id headers). */
const WEBHOOK_HEADER = /^(stripe-signature|x-hub-signature(-256)?|x-github-(delivery|event)|x-paystack-signature|verif-hash|x-shopify-(hmac-sha256|webhook-id)|svix-(id|signature)|webhook-(id|signature)|x-twilio-signature|paypal-transmission-(id|sig)|x-razorpay-signature|x-signature|x-webhook-signature)$/i;

function readsWebhookHeader(c: Candidate): boolean {
  return c.fn
    .getDescendants()
    .some((n) => (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) && WEBHOOK_HEADER.test(n.getLiteralValue()));
}

function inferProvider(c: Candidate, file: string, checks: Check[]): string | undefined {
  if (c.framework === "probot") return "github";
  const fromCheck = checks.find((k) => k.provider)?.provider;
  if (fromCheck) return fromCheck;
  const hay = `${c.routePath ?? ""} ${file}`.toLowerCase();
  return KNOWN_PROVIDERS.find((p) => hay.includes(p));
}

export function analyzeLoaded(loaded: LoadedProject, opts: AnalyzeOptions = {}): AnalysisResult {
  const candidates = discover(loaded, opts);
  const minRank = CONFIDENCE_RANK[opts.minConfidence ?? "medium"];
  const serialized = opts.handlers?.serialized ?? [];
  const isSerializedFile = serialized.length ? picomatch(serialized, { dot: true }) : () => false;
  const handlers: HandlerReport[] = [];
  const schema = loadSchema(loaded.project.getFileSystem(), loaded.root, loaded.sourceFiles);

  const lines = new Map<string, string[]>();
  const lineOf = (file: string, line: number): string | undefined => {
    if (!lines.has(file)) {
      const sf = loaded.project.getSourceFile(path.join(loaded.root, file));
      lines.set(file, sf ? sf.getFullText().split("\n") : []);
    }
    return lines.get(file)![line - 1];
  };

  for (const c of candidates) {
    const walker = new Walker({
      root: loaded.root,
      maxCallDepth: opts.maxCallDepth ?? 6,
      customGuards: opts.guards ?? [],
      extraEffects: opts.effects ?? [],
    });
    const mw = resolveMiddleware(c.middleware ?? [], opts.guards ?? []);
    // A handler registered through withGuard(guard, key, handler) runs once per key.
    const wrapper = c.fn.getParent();
    const adapter = wrapper && guardLibraryAdapter(wrapper);
    if (adapter) mw.guards.push({ node: wrapper, guard: adapter });
    const walked = walker.run(c.fn, mw.fns, mw.guards);
    const signals = [...c.signals];
    if (walked.checks.length) signals.push("signature-verify");
    if (readsWebhookHeader(c)) signals.push("webhook-header");
    if (!c.alwaysAtLeastOnce && signals.length === 0) continue;

    const loc = location(c.anchor, loaded.root);
    const handler: Handler = {
      id: `${c.framework}:${loc.file}:${loc.line}:${c.name}`,
      kind: c.kind,
      framework: c.framework,
      name: c.name,
      location: loc,
      provider: inferProvider(c, loc.file, walked.checks),
      signals,
      serialized: serialized.includes(c.name) || isSerializedFile(loc.file) || undefined,
      fnLocation: location(c.fn, loaded.root),
    };
    const p = handler.provider;
    handler.retryWindowHours = p ? (opts.providers?.[p]?.retryWindowHours ?? PROVIDERS[p]?.retryWindowHours) : undefined;
    const report: HandlerReport = { handler, ...walked, eventTypes: eventTypes(c.fn), checksOrdering: checksOrdering(c.fn), findings: [] };
    applySchema(report, schema);

    // Fingerprint on rule + handler + file + flagged line text (not line numbers), numbering repeats.
    const seen = new Map<string, number>();
    report.findings = runRules(report, opts.rules)
      .filter((f) => CONFIDENCE_RANK[f.confidence] >= minRank)
      .map((f): Finding => {
        const base = [f.rule, c.framework, c.name, f.location.file, (lineOf(f.location.file, f.location.line) ?? "").trim()];
        const key = base.join("|");
        const n = seen.get(key) ?? 0;
        seen.set(key, n + 1);
        return { id: fingerprint([...base, String(n)]), ...f };
      });
    handlers.push(report);
  }

  const { active, suppressed } = applyInlineSuppressions(
    handlers.flatMap((h) => h.findings),
    lineOf,
  );
  const byId = new Map(active.map((f) => [f.id, f]));
  for (const h of handlers) h.findings = h.findings.flatMap((f) => byId.get(f.id) ?? []);

  return { root: loaded.root, candidates: candidates.length, handlers, findings: active, suppressed };
}

export function analyze(opts: AnalyzeOptions = {}): AnalysisResult {
  const projects = opts.project ? [fromProject(opts.project, opts.root ?? "/")] : loadProjects(opts.root ?? process.cwd(), opts.tsconfig);
  return mergeResults(projects.map((p) => analyzeLoaded(p, opts)));
}

/** Combine per-package results; a file included by two tsconfigs yields its handlers once. */
export function mergeResults(results: AnalysisResult[]): AnalysisResult {
  if (results.length === 1) return results[0]!;
  const seen = new Set<string>();
  const handlers = results.flatMap((r) => r.handlers).filter((h) => !seen.has(h.handler.id) && seen.add(h.handler.id));
  const kept = new Set(handlers.map((h) => h.handler.id));
  return {
    root: results[0]?.root ?? "",
    candidates: results.reduce((n, r) => n + r.candidates, 0),
    handlers,
    findings: handlers.flatMap((h) => h.findings),
    suppressed: results.flatMap((r) => r.suppressed).filter((s) => kept.has(s.finding.handler)),
  };
}
