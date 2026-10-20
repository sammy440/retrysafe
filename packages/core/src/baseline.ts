import type { AnalysisResult, Finding } from "./types";

export interface BaselineEntry {
  id: string;
  rule: string;
  file: string;
  handler: string;
  message: string;
}

export interface Baseline {
  version: 1;
  findings: BaselineEntry[];
}

export function createBaseline(findings: Finding[], handlerName: (id: string) => string): Baseline {
  return {
    version: 1,
    findings: findings
      .map((f) => ({ id: f.id, rule: f.rule, file: f.location.file, handler: handlerName(f.handler), message: f.message }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.id.localeCompare(b.id)),
  };
}

export function parseBaseline(json: string, source = "baseline"): Baseline {
  const data = JSON.parse(json) as Partial<Baseline>;
  if (data.version !== 1 || !Array.isArray(data.findings)) throw new Error(`${source}: not a retrysafe baseline (version 1)`);
  return data as Baseline;
}

/** Move findings recorded in the baseline from `findings` to `suppressed`. */
export function applyBaseline(result: AnalysisResult, baseline: Baseline): AnalysisResult {
  const known = new Set(baseline.findings.map((f) => f.id));
  const findings: Finding[] = [];
  const suppressed = [...result.suppressed];
  for (const f of result.findings) {
    if (known.has(f.id)) suppressed.push({ finding: f, by: "baseline" });
    else findings.push(f);
  }
  const active = new Set(findings);
  return {
    ...result,
    findings,
    suppressed,
    handlers: result.handlers.map((h) => ({ ...h, findings: h.findings.filter((f) => active.has(f)) })),
  };
}

/** Baseline entries whose findings no longer occur; worth pruning with --update-baseline. */
export function staleBaselineEntries(result: AnalysisResult, baseline: Baseline): BaselineEntry[] {
  const seen = new Set([...result.findings, ...result.suppressed.map((s) => s.finding)].map((f) => f.id));
  return baseline.findings.filter((e) => !seen.has(e.id));
}
