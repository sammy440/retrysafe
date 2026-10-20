import type { Finding, SuppressedFinding } from "./types";

/**
 * Inline suppression comments, on the flagged line or the line above:
 *
 *   await sendEmail(); // retrysafe-ignore unguarded-side-effect -- emails are deduplicated by the ESP
 *   // retrysafe-ignore-next-line nondeterministic-key, effect-missing-idempotency-key -- test-only route
 *
 * A reason after `--` is required; a suppression without one is not honored.
 */
const PATTERN = /retrysafe-ignore(-next-line)?\s+([\w*-]+(?:\s*,\s*[\w*-]+)*)(?:\s+--\s*(.*?))?\s*(?:\*\/)?\s*$/;

interface Suppression {
  rules: string[];
  reason: string;
}

function parse(line: string | undefined, nextLine: boolean): Suppression | undefined {
  const m = line?.match(PATTERN);
  if (!m || !!m[1] !== nextLine) return undefined;
  return { rules: m[2]!.split(",").map((r) => r.trim()), reason: (m[3] ?? "").trim() };
}

/** Split findings into active and inline-suppressed, given a way to read source lines. */
export function applyInlineSuppressions(
  findings: Finding[],
  lineOf: (file: string, line: number) => string | undefined,
): { active: Finding[]; suppressed: SuppressedFinding[] } {
  const active: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const f of findings) {
    const { file, line } = f.location;
    const s = parse(lineOf(file, line), false) ?? parse(lineOf(file, line - 1), true);
    if (!s || !(s.rules.includes(f.rule) || s.rules.includes("*"))) {
      active.push(f);
      continue;
    }
    if (!s.reason) {
      active.push({ ...f, suppressionError: "retrysafe-ignore needs a reason after `--`; suppression not applied" });
      continue;
    }
    suppressed.push({ finding: f, by: "inline", reason: s.reason });
  }
  return { active, suppressed };
}
