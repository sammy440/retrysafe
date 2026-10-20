import { appendFileSync } from "node:fs";
import path from "node:path";
import type { AnalysisResult, Severity } from "@retrysafe/core";
import { renderMarkdown } from "./markdown";

const COMMAND: Record<Severity, string> = { error: "error", warning: "warning", info: "notice" };

// https://docs.github.com/en/actions/reference/workflow-commands-for-github-actions
const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProp = (s: string) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/**
 * GitHub Actions workflow commands: one annotation per finding on its exact line, plus the Markdown
 * report in the job summary when GITHUB_STEP_SUMMARY is set.
 */
export function renderGithub(result: AnalysisResult): string {
  const lines: string[] = [];
  for (const f of result.findings) {
    // Annotations need paths relative to the repository root (the working directory in Actions).
    const file = path.relative(process.cwd(), path.join(result.root, f.location.file)).split(path.sep).join("/");
    const props = `file=${escapeProp(file)},line=${f.location.line},col=${f.location.column},title=${escapeProp(`retrysafe ${f.rule} (${f.confidence} confidence)`)}`;
    const body = [f.message, "", ...f.failingSequence.map((s, i) => `${i + 1}. ${s}`), "", `Fix: ${f.fix}`, `Details: npx retrysafe explain ${f.id}`].join("\n");
    lines.push(`::${COMMAND[f.severity]} ${props}::${escapeData(body)}`);
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, renderMarkdown(result));
  lines.push(`retrysafe: ${result.findings.length} finding(s) in ${result.handlers.length} handler(s)`);
  return `${lines.join("\n")}\n`;
}
