import type { Project } from "ts-morph";
import { Walker, location } from "./analysis/walker";
import { discoverExpress } from "./discovery/express";
import { discoverNext } from "./discovery/next";
import { discoverQueues } from "./discovery/queues";
import type { Candidate } from "./discovery/types";
import type { EffectCatalogEntry } from "./effects/catalog";
import type { CustomGuard } from "./guards/detect";
import { fromProject, loadProject, type LoadedProject } from "./project/loader";
import { runRules, type RuleSetting } from "./rules";
import type { AnalysisResult, Check, Confidence, Handler, HandlerReport } from "./types";

export interface AnalyzeOptions {
  /** Directory to analyze. Defaults to the current working directory. */
  root?: string;
  tsconfig?: string;
  /** Analyze an existing ts-morph project (e.g. in-memory, for tests or the playground). */
  project?: Project;
  maxCallDepth?: number;
  minConfidence?: Confidence;
  guards?: CustomGuard[];
  effects?: EffectCatalogEntry[];
  rules?: Record<string, RuleSetting>;
}

const KNOWN_PROVIDERS = ["stripe", "paystack", "flutterwave", "shopify", "github", "twilio", "sendgrid", "resend", "clerk", "paypal"];
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function discover(loaded: LoadedProject): Candidate[] {
  return [
    ...discoverExpress(loaded.sourceFiles),
    ...discoverNext(loaded.sourceFiles, loaded.root),
    ...discoverQueues(loaded.sourceFiles),
  ];
}

function inferProvider(c: Candidate, file: string, checks: Check[]): string | undefined {
  const fromCheck = checks.find((k) => k.provider)?.provider;
  if (fromCheck) return fromCheck;
  const hay = `${c.routePath ?? ""} ${file}`.toLowerCase();
  return KNOWN_PROVIDERS.find((p) => hay.includes(p));
}

export function analyzeLoaded(loaded: LoadedProject, opts: AnalyzeOptions = {}): AnalysisResult {
  const candidates = discover(loaded);
  const minRank = CONFIDENCE_RANK[opts.minConfidence ?? "medium"];
  const handlers: HandlerReport[] = [];

  for (const c of candidates) {
    const walker = new Walker({
      root: loaded.root,
      maxCallDepth: opts.maxCallDepth ?? 6,
      customGuards: opts.guards ?? [],
      extraEffects: opts.effects ?? [],
    });
    const walked = walker.run(c.fn);
    const signals = [...c.signals];
    if (walked.checks.length) signals.push("signature-verify");
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
    };
    const report: HandlerReport = { handler, ...walked, findings: [] };
    report.findings = runRules(report, opts.rules).filter((f) => CONFIDENCE_RANK[f.confidence] >= minRank);
    handlers.push(report);
  }

  return {
    root: loaded.root,
    candidates: candidates.length,
    handlers,
    findings: handlers.flatMap((h) => h.findings),
  };
}

export function analyze(opts: AnalyzeOptions = {}): AnalysisResult {
  const loaded = opts.project ? fromProject(opts.project, opts.root ?? "/") : loadProject(opts.root ?? process.cwd(), opts.tsconfig);
  return analyzeLoaded(loaded, opts);
}
