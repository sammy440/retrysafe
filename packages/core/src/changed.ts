import type { AnalysisResult, HandlerReport } from "./types";

/** Every file a handler's analysis touched: the handler, its call paths, effects, guards, and records. */
export function handlerFiles(h: HandlerReport): Set<string> {
  const files = new Set<string>([h.handler.location.file]);
  for (const e of h.effects) {
    files.add(e.location.file);
    for (const p of e.path) files.add(p.file);
  }
  for (const g of h.guards) {
    files.add(g.location.file);
    for (const p of g.path) files.add(p.file);
    if (g.schemaSource) files.add(g.schemaSource);
  }
  for (const r of h.records) files.add(r.location.file);
  return files;
}

/** Keep only handlers affected by a change to any of `files` (paths relative to the analyzed root). */
export function filterByChangedFiles(result: AnalysisResult, files: Iterable<string>): AnalysisResult {
  const changed = new Set([...files].map((f) => f.split("\\").join("/")));
  const handlers = result.handlers.filter((h) => [...handlerFiles(h)].some((f) => changed.has(f)));
  const kept = new Set(handlers.map((h) => h.handler.id));
  return {
    ...result,
    handlers,
    findings: result.findings.filter((f) => kept.has(f.handler)),
    suppressed: result.suppressed.filter((s) => kept.has(s.finding.handler)),
  };
}
