import type { HandlerReport, Severity } from "../types";
import type { Rule, RuleFinding } from "./shared";
import { checkThenInsertRace } from "./check-then-insert-race";
import { effectBeforeRecord } from "./effect-before-record";
import { effectMissingIdempotencyKey } from "./effect-missing-idempotency-key";
import { nondeterministicKey } from "./nondeterministic-key";
import { recordBeforeEffectNoTx } from "./record-before-effect-no-tx";
import { ackTiming } from "./ack-timing";
import { dedupeTtlShort } from "./dedupe-ttl-short";
import { incrementingWriteUnguarded } from "./incrementing-write-unguarded";
import { nonAtomicMultiWrite } from "./non-atomic-multi-write";
import { orderDependenceAssumed } from "./order-dependence-assumed";
import { permanentErrorReturns5xx } from "./permanent-error-returns-5xx";
import { queueAddWithoutJobId } from "./queue-add-without-job-id";
import { retryLoopWithEffect } from "./retry-loop-with-effect";
import { swallowedErrorReturns2xx } from "./swallowed-error-returns-2xx";
import { unguardedSideEffect } from "./unguarded-side-effect";
import { wrongEventFieldAsKey } from "./wrong-event-field-as-key";

export type { Rule, RuleDocs, RuleFinding } from "./shared";

export const RULES: Rule[] = [
  unguardedSideEffect,
  recordBeforeEffectNoTx,
  checkThenInsertRace,
  effectBeforeRecord,
  nondeterministicKey,
  effectMissingIdempotencyKey,
  swallowedErrorReturns2xx,
  permanentErrorReturns5xx,
  ackTiming,
  wrongEventFieldAsKey,
  incrementingWriteUnguarded,
  nonAtomicMultiWrite,
  retryLoopWithEffect,
  queueAddWithoutJobId,
  dedupeTtlShort,
  orderDependenceAssumed,
];

export type RuleSetting = Severity | "off";

export function runRules(report: HandlerReport, settings: Record<string, RuleSetting> = {}): RuleFinding[] {
  const out: RuleFinding[] = [];
  for (const rule of RULES) {
    const setting = settings[rule.id] ?? rule.severity;
    if (setting === "off") continue;
    for (const f of rule.run(report)) out.push({ ...f, severity: setting });
  }
  return out;
}
