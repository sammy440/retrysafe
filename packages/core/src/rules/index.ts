import type { Finding, HandlerReport, Severity } from "../types";
import type { Rule } from "./shared";
import { effectBeforeRecord } from "./effect-before-record";
import { effectMissingIdempotencyKey } from "./effect-missing-idempotency-key";
import { nondeterministicKey } from "./nondeterministic-key";
import { recordBeforeEffectNoTx } from "./record-before-effect-no-tx";
import { unguardedSideEffect } from "./unguarded-side-effect";

export type { Rule } from "./shared";

export const RULES: Rule[] = [
  unguardedSideEffect,
  recordBeforeEffectNoTx,
  effectBeforeRecord,
  nondeterministicKey,
  effectMissingIdempotencyKey,
];

export type RuleSetting = Severity | "off";

export function runRules(report: HandlerReport, settings: Record<string, RuleSetting> = {}): Finding[] {
  const out: Finding[] = [];
  for (const rule of RULES) {
    const setting = settings[rule.id] ?? rule.severity;
    if (setting === "off") continue;
    for (const f of rule.run(report)) out.push({ ...f, severity: setting });
  }
  return out;
}
