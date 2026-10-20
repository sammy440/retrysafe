import type { Effect, HandlerReport } from "../types";
import { deliveryNarrative, effectiveGuards, transactionalClaim, type Rule, type RuleFinding } from "./shared";

export function isRelativeWrite(e: Effect): boolean {
  return e.kind === "db-write" && e.idempotent === false && !!e.note && /increment|decrement|relative|\$inc|\$push|\$mul|push on|multiply|divide/i.test(e.note);
}

/** x = x + n, ORM increment, $inc, array push: a retry applies the change again. */
export const incrementingWriteUnguarded: Rule = {
  id: "incrementing-write-unguarded",
  severity: "error",
  docs: {
    summary: "A relative write (increment, x = x + n, $inc, push) runs with no dedupe guard.",
    why: "Unlike setting a value, applying a delta is not idempotent: every redelivery adds it again, silently corrupting balances and counters.",
    safePattern: "Claim the event in the same transaction as the write, or store the event's contribution keyed by event id and derive the total from it.",
  },
  run(report: HandlerReport): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const e of report.effects) {
      if (!isRelativeWrite(e) || effectiveGuards(e).length > 0) continue;
      const story = deliveryNarrative(report.handler);
      out.push({
        rule: this.id,
        severity: this.severity,
        confidence: e.path.length <= 1 ? "high" : "medium",
        handler: report.handler.id,
        location: e.location,
        effect: e,
        message: `${e.callee} (${e.note}) has no guard; each redelivery applies the change again`,
        failingSequence: [`${story.first}; handler runs ${e.callee}`, story.retry, `Handler runs ${e.callee} again: the value is applied twice`],
        fix: "Insert the event id into a processed-events table with a unique constraint in the same transaction as this write, and skip when it conflicts.",
        snippet: transactionalClaim(e.module),
      });
    }
    return out;
  },
};
