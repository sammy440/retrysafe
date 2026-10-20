import type { HandlerReport } from "../types";
import { SNIPPETS, transactionalClaim, at, deliveryNarrative, sameTransaction, type Rule, type RuleFinding } from "./shared";

/**
 * The event is claimed first, then the work runs outside the claim's transaction. A crash after the
 * claim leaves the event marked as processed with the work undone; the retry is skipped and the event is lost.
 */
export const recordBeforeEffectNoTx: Rule = {
  id: "record-before-effect-no-tx",
  severity: "error",
  docs: {
    summary: "The event is marked processed before its work runs, outside one transaction and with no rollback.",
    why: "If the process dies after the claim, the event stays marked as processed with its work undone. The retry is skipped as a duplicate and the event is lost.",
    safePattern: "Insert the processed-event row in the same transaction as the writes. For external effects, release the claim on failure, use a short lease TTL, or use an outbox.",
  },
  run(report: HandlerReport): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const record of report.records) {
      const guard = record.guard;
      // A claim the schema shows is not unique does not claim anything (unguarded-side-effect reports that).
      if (record.kind !== "claim" || !guard || guard.atomic === false) continue;
      const after = report.effects.filter((e) => e.kind !== "unknown" && e.order > record.order && e.protectedBy.includes(guard) && !sameTransaction(record, e));
      const first = after[0];
      if (!first) continue;

      const story = deliveryNarrative(report.handler);
      const names = after.map((e) => e.callee);
      const list = names.length > 2 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(" and ");
      // A release in a catch block covers thrown errors but not a killed process; a Redis TTL may act as a lease.
      const confidence = report.releases.length > 0 ? "low" : guard.kind === "redis-setnx" ? "medium" : "high";
      const dbOnly = after.every((e) => e.kind === "db-write");

      out.push({
        rule: this.id,
        severity: this.severity,
        confidence,
        handler: report.handler.id,
        location: record.location,
        effect: first,
        message: `Event is claimed (${record.description}) before ${list} (${at(first.location)}), outside one transaction; a crash in between loses the event`,
        failingSequence: [
          `${story.first}; handler records it (${record.description})`,
          `The process crashes before ${first.callee} completes`,
          `${story.retry}; the record exists, so the handler skips it`,
          `${first.callee} never happens: the event is lost`,
        ],
        fix: dbOnly
          ? "Insert the processed-event row inside the same transaction as these writes (e.g. prisma.$transaction), so a crash rolls back both and the retry redoes the work."
          : "Make the claim reversible: delete it when the work fails (catch block) and give it a short TTL as a lease, or write an outbox row in the same transaction as the claim and perform external calls from a worker with idempotency keys.",
        snippet: dbOnly ? transactionalClaim(first.module) : SNIPPETS.releasableClaim,
      });
    }
    return out;
  },
};
