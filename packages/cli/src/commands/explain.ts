import { RULES, type AnalysisResult, type Finding } from "@retrysafe/core";

const at = (l: { file: string; line: number }) => `${l.file}:${l.line}`;

export function findFinding(result: AnalysisResult, id: string): { finding: Finding; note?: string } | undefined {
  const active = result.findings.find((f) => f.id.startsWith(id));
  if (active) return { finding: active };
  const s = result.suppressed.find((x) => x.finding.id.startsWith(id));
  if (s) return { finding: s.finding, note: s.by === "baseline" ? "suppressed by the baseline" : `suppressed inline: ${s.reason}` };
  return undefined;
}

export function renderExplain(result: AnalysisResult, id: string): string | undefined {
  const found = findFinding(result, id);
  if (!found) return undefined;
  const f = found.finding;
  const rule = RULES.find((r) => r.id === f.rule);
  const handler = result.handlers.find((h) => h.handler.id === f.handler)?.handler;
  const lines = [
    `${f.rule} [${f.id}]  ${f.severity}, ${f.confidence} confidence${found.note ? `  (${found.note})` : ""}`,
    "",
    rule ? rule.docs.summary : "",
    "",
    `Handler:  ${handler ? `${handler.name}  (${at(handler.location)})` : f.handler}`,
    `Location: ${at(f.location)}`,
  ];
  if (f.effect?.path.length) lines.push(`Call path: ${[...f.effect.path, f.effect.location].map(at).join(" → ")}`);
  lines.push("", f.message, "", "What goes wrong:", ...f.failingSequence.map((s, i) => `  ${i + 1}. ${s}`));
  if (rule) lines.push("", "Why:", `  ${rule.docs.why}`, "", "Safe pattern:", `  ${rule.docs.safePattern}`);
  lines.push("", "Fix:", `  ${f.fix}`);
  if (f.snippet) lines.push("", ...f.snippet.split("\n").map((l) => `    ${l}`));
  lines.push(
    "",
    `To accept this finding, add on or above the line:  // retrysafe-ignore ${f.rule} -- <reason>`,
    "or record all current findings with: retrysafe --update-baseline",
  );
  return lines.join("\n");
}
