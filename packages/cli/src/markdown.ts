import type { AnalysisResult, Effect, HandlerReport, SourceLocation } from "@retrysafe/core";

const at = (l: SourceLocation) => `\`${l.file}:${l.line}\``;
const cell = (s: string) => s.replace(/\|/g, "\\|");

function effectRow(e: Effect, report: HandlerReport): string {
  const rules = report.findings.filter((f) => f.effect === e).map((f) => `\`${f.rule}\``);
  const guard = e.protectedBy[e.protectedBy.length - 1];
  const status = e.hasIdempotencyKey
    ? "idempotency key"
    : guard
      ? `guarded by ${guard.description}${guard.atomic === false ? " (not atomic)" : ""}`
      : e.idempotent === true
        ? "idempotent"
        : e.idempotent === false
          ? "**no guard**"
          : "unknown";
  return `| ${rules.length ? "❌" : "✅"} | ${e.kind} | \`${cell(e.callee)}\` | ${at(e.location)} | ${cell(status)} | ${rules.join(", ")} |`;
}

export function renderMarkdown(result: AnalysisResult): string {
  const out: string[] = ["# retrysafe report", ""];
  const flagged = result.handlers.filter((h) => h.findings.length);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of result.findings) counts[f.severity]++;
  out.push(
    `${result.handlers.length} at-least-once handlers found; ${flagged.length} need attention. ` +
      `**${counts.error}** errors, **${counts.warning}** warnings, **${counts.info}** info.`,
    "",
  );
  if (!flagged.length) return `${out.join("\n")}\n`;

  for (const h of flagged) {
    out.push(`## ${h.handler.name}`, "", `${at(h.handler.location)} · ${h.handler.framework}`, "");
    if (h.effects.length) {
      out.push("| | Kind | Effect | Location | Status | Rules |", "|---|---|---|---|---|---|", ...h.effects.map((e) => effectRow(e, h)), "");
    }
    for (const f of h.findings) {
      out.push(
        `### \`${f.rule}\` (${f.severity}, ${f.confidence} confidence) at ${at(f.location)}`,
        "",
        f.message,
        "",
        "**Failing sequence**",
        "",
        ...f.failingSequence.map((s, i) => `${i + 1}. ${s}`),
        "",
        `**Fix:** ${f.fix}`,
        "",
      );
      if (f.snippet) out.push("```ts", f.snippet, "```", "");
    }
  }
  return `${out.join("\n")}\n`;
}
