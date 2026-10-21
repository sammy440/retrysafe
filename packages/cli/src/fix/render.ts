import type { FixResult } from "./index";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { red: paint("31"), green: paint("32"), cyan: paint("36"), dim: paint("2"), bold: paint("1") };

function colorDiff(diff: string): string {
  return diff
    .split("\n")
    .map((l) => (l.startsWith("+++") || l.startsWith("---") ? c.bold(l) : l.startsWith("@@") ? c.cyan(l) : l.startsWith("+") ? c.green(l) : l.startsWith("-") ? c.red(l) : l))
    .join("\n");
}

export function renderFix(r: FixResult, written: boolean): string {
  const out: string[] = [];
  for (const d of r.diffs) out.push(colorDiff(d.diff));
  if (r.applied.length) {
    out.push(c.bold(`${written ? "Applied" : "Would apply"} ${r.applied.length} fix${r.applied.length === 1 ? "" : "es"}:`));
    for (const a of r.applied) out.push(`  ${c.green("✔")} ${a.rule}  ${a.file}:${a.line}  ${c.dim(a.description)}`);
  }
  if (r.skipped.length) {
    out.push("", c.bold(`Not fixed automatically (${r.skipped.length}):`));
    for (const s of r.skipped) out.push(`  · ${s.rule}  ${s.file}:${s.line}  ${c.dim(s.reason)}`);
  }
  if (!r.applied.length && !r.skipped.length) out.push("retrysafe fix: nothing to fix.");
  out.push(
    "",
    written
      ? c.dim("Review the changes, then run retrysafe again to confirm the findings are gone.")
      : c.dim("Dry run. Re-run with --write to apply; add --guard <module>#<export> to wrap handlers with @retrysafe/guard."),
  );
  return out.join("\n");
}
