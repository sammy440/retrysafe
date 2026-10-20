import type { AnalysisResult, Effect, Finding, HandlerReport, SourceLocation } from "@retrysafe/core";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { red: paint("31"), green: paint("32"), yellow: paint("33"), cyan: paint("36"), dim: paint("2"), bold: paint("1") };

const at = (l: SourceLocation) => `${l.file}:${l.line}`;
const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s + " ".repeat(n - s.length));

function effectStatus(e: Effect): { mark: string; reason: string } {
  if (e.hasIdempotencyKey) return { mark: c.green("✔"), reason: c.dim(`idempotency key (${e.acceptsIdempotencyKey?.field})`) };
  const guard = e.protectedBy[e.protectedBy.length - 1];
  if (guard) {
    const note = guard.atomic === false ? c.yellow(" (not atomic)") : "";
    return { mark: guard.atomic === false ? c.yellow("⚠") : c.green("✔"), reason: c.dim(`guarded by ${guard.description}`) + note };
  }
  if (e.idempotent === true) return { mark: c.green("✔"), reason: c.dim(e.note ? `idempotent: ${e.note}` : "idempotent") };
  if (e.idempotent === false) return { mark: c.red("✖"), reason: c.red("no guard on this path") };
  return { mark: c.yellow("?"), reason: c.dim(e.note ?? "idempotency unknown") };
}

export function effectMap(report: HandlerReport): string[] {
  const flaggedBy = new Map<Effect, Finding[]>();
  for (const f of report.findings) if (f.effect) flaggedBy.set(f.effect, [...(flaggedBy.get(f.effect) ?? []), f]);
  const rows: { order: number; text: string }[] = [
    ...report.checks.map((k) => ({ order: k.order, text: `${c.green("✔")} ${pad("verify", 10)} ${pad(k.callee, 34)} ${c.dim(at(k.location))}` })),
    ...report.guards.map((g) => ({
      order: g.order,
      text: `${c.cyan("◆")} ${pad("guard", 10)} ${pad(g.description, 34)} ${c.dim(at(g.location))}  ${c.dim(g.kind + (g.atomic === false ? ", not atomic" : g.atomic === "unknown" ? ", atomic if unique constraint" : ""))}`,
    })),
    ...report.records
      .filter((r) => r.kind === "marker-write")
      .map((r) => ({ order: r.order, text: `${c.cyan("●")} ${pad("record", 10)} ${pad(r.description, 34)} ${c.dim(at(r.location))}` })),
    ...report.effects.map((e) => {
      const s = effectStatus(e);
      const findings = flaggedBy.get(e) ?? [];
      const mark = findings.some((f) => f.severity === "error") ? c.red("✖") : findings.length ? c.yellow("⚠") : s.mark;
      const rules = findings.length ? `  ${c.dim("→")} ${findings.map((f) => f.rule).join(", ")}` : "";
      const via = e.path.length ? c.dim(` (via ${at(e.path[0]!)})`) : "";
      return { order: e.order, text: `${mark} ${pad(e.kind, 10)} ${pad(e.callee, 34)} ${c.dim(at(e.location))}${via}  ${s.reason}${rules}` };
    }),
  ];
  return rows.sort((a, b) => a.order - b.order).map((r) => `    ${r.text}`);
}

function finding(f: Finding): string[] {
  const color = f.severity === "error" ? c.red : f.severity === "warning" ? c.yellow : c.cyan;
  return [
    `  ${color(f.severity === "error" ? "✖" : "⚠")} ${c.bold(f.rule)}  ${c.dim(`(${f.severity}, ${f.confidence} confidence)`)}  ${at(f.location)}  ${c.dim(`[${f.id}]`)}`,
    `      ${f.message}`,
    "      Failing sequence:",
    ...f.failingSequence.map((s, i) => `        ${i + 1}. ${s}`),
    `      Fix: ${f.fix}`,
    ...(f.snippet ? ["", ...f.snippet.split("\n").map((l) => `        ${c.dim(l)}`)] : []),
  ];
}

export interface TerminalOptions {
  handlersOnly?: boolean;
  allEffectMaps?: boolean;
}

export function renderTerminal(result: AnalysisResult, opts: TerminalOptions = {}): string {
  const lines: string[] = [];
  const attention = result.handlers.filter((h) => h.findings.length > 0);

  if (opts.handlersOnly) {
    lines.push(`retrysafe: ${result.handlers.length} at-least-once handlers (${result.candidates} routes and workers inspected)`, "");
    for (const h of result.handlers) {
      lines.push(`${pad(h.handler.name, 40)} ${c.dim(at(h.handler.location))}  ${c.dim(`${h.handler.framework}; ${h.handler.signals.join(", ")}`)}`);
    }
    return lines.join("\n");
  }

  lines.push(
    attention.length
      ? `retrysafe: ${c.bold(String(attention.length))} handler${attention.length === 1 ? "" : "s"} need attention (${result.handlers.length} discovered)`
      : `retrysafe: ${c.green("no findings")} (${result.handlers.length} handlers discovered)`,
  );

  for (const h of result.handlers) {
    if (!opts.allEffectMaps && h.findings.length === 0) continue;
    lines.push("", `${c.bold(pad(h.handler.name, 40))} ${c.dim(at(h.handler.location))}`, "  Effect map");
    const map = effectMap(h);
    lines.push(...(map.length ? map : [c.dim("    (no effects found)")]));
    for (const f of h.findings) lines.push("", ...finding(f));
  }

  const clean = result.handlers.length - attention.length;
  lines.push("", `${clean} handler${clean === 1 ? "" : "s"} clean. ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}.`);
  return lines.join("\n");
}
