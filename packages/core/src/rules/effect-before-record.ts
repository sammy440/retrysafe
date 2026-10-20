import type { HandlerReport } from "../types";
import { SNIPPETS, effectiveGuards, transactionalClaim, at, consequence, deliveryNarrative, sameTransaction, stableId, type Rule, type RuleFinding } from "./shared";

/**
 * The handler checks "seen before?", does the work, and records the event only afterwards.
 * A crash between the work and the record leaves no record, so the retry does the work again.
 */
export const effectBeforeRecord: Rule = {
  id: "effect-before-record",
  severity: "warning",
  docs: {
    summary: "An effect runs before the event is recorded, behind a check that is not an atomic claim.",
    why: "If the process dies between the effect and the record, the retry finds no record, passes the check, and repeats the effect.",
    safePattern: "Record and write in one transaction for DB effects; for external calls use an idempotency key or an outbox written in the same transaction as the record.",
  },
  run(report: HandlerReport): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const e of report.effects) {
      if (e.idempotent !== false || e.hasIdempotencyKey || e.kind === "unknown") continue;
      // Unguarded effects are reported by unguarded-side-effect; effects behind an atomic claim are recorded before they run.
      const guards = effectiveGuards(e);
      if (guards.length === 0 || guards.some((g) => g.kind !== "lookup-then-insert")) continue;
      const record = report.records.find((r) => r.order > e.order && !sameTransaction(r, e));
      if (!record) continue;
      const story = deliveryNarrative(report.handler);
      out.push({
        rule: this.id,
        severity: this.severity,
        confidence: "medium",
        handler: report.handler.id,
        location: e.location,
        effect: e,
        message: `${e.kind} \`${e.callee}\` runs before the event is recorded (${record.description} at ${at(record.location)})`,
        failingSequence: [
          `${story.first}; the check finds no record, handler runs ${e.callee}`,
          `The process crashes or times out before ${record.description} (${at(record.location)})`,
          `${story.retry}; still no record, so the check lets it through`,
          `Handler runs ${e.callee} again: ${consequence(e)}`,
        ],
        fix:
          e.kind === "db-write"
            ? "Record the event in the same transaction as this write (insert the event id into a unique processed-events table inside the transaction), so both commit or neither does."
            : e.acceptsIdempotencyKey
              ? `Pass \`${e.acceptsIdempotencyKey.field}\` derived from the event id so a repeated call is deduplicated by the provider.`
              : "Claim the event atomically before the effect, or write an outbox row in the same transaction as the record and send from a worker that deduplicates.",
        snippet:
          e.kind === "db-write"
            ? transactionalClaim(e.module)
            : e.acceptsIdempotencyKey
              ? SNIPPETS.idempotencyKey(e.acceptsIdempotencyKey.field, stableId(report.handler))
              : SNIPPETS.releasableClaim,
      });
    }
    return out;
  },
};
