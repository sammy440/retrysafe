import type { Effect, Handler, HandlerReport } from "../types";
import { isRelativeWrite } from "./incrementing-write-unguarded";
import { SNIPPETS, effectiveGuards, transactionalClaim, consequence, deliveryNarrative, stableId, type Rule, type RuleFinding } from "./shared";

function fix(e: Effect, h: Handler): string {
  if (e.module.includes("shopify") && e.note?.startsWith("mutation")) {
    return `Add Shopify's @idempotent(key: ...) directive to the mutation, with a key derived from ${stableId(h)}, if the mutation supports it; otherwise claim the event atomically before calling it.`;
  }
  if (e.acceptsIdempotencyKey?.field === "MessageDeduplicationId") {
    return `Send to a FIFO queue with MessageDeduplicationId derived from ${stableId(h)} (standard queues ignore it), or claim the event atomically before enqueuing.`;
  }
  if (e.acceptsIdempotencyKey) {
    return (
      `Pass \`${e.acceptsIdempotencyKey.field}\` derived from ${stableId(h)} (argument ${e.acceptsIdempotencyKey.arg + 1}), ` +
      `e.g. { ${e.acceptsIdempotencyKey.field}: \`evt_\${${stableId(h)}}\` }, so the provider deduplicates the retry.`
    );
  }
  switch (e.kind) {
    case "db-write":
      return (
        "Insert the event id into a processed-events table with a unique constraint, in the same transaction as this write, " +
        "and skip the work when the insert conflicts. Alternatively make the write an upsert keyed by the event."
      );
    case "email":
    case "sms":
      return (
        "Claim the event atomically before sending (unique insert into a processed-events table, or Redis SET NX keyed by " +
        "the event id) and skip when the claim fails; or send through an outbox written in the same transaction as your data."
      );
    default:
      return "Guard this effect with an atomic dedupe record keyed by the event id (unique insert or Redis SET NX) and skip duplicates.";
  }
}

export const unguardedSideEffect: Rule = {
  id: "unguarded-side-effect",
  severity: "error",
  docs: {
    summary: "A non-idempotent effect (payment, email, plain insert, increment) runs with no dedupe guard on its path.",
    why: "Webhook providers and queues deliver at least once. A timeout, deploy, or manual resend runs the handler again with the same event, and every unguarded effect happens again.",
    safePattern: "Claim the event atomically before the effect (unique insert in the same transaction as DB writes, or Redis SET NX), or pass the provider's idempotency key derived from the event id.",
  },
  run(report: HandlerReport): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const e of report.effects) {
      // Unresolved calls with effect-like names are reported too, but only at low confidence.
      const unresolved = e.kind === "unknown" && e.module === "(unresolved)";
      if ((e.idempotent !== false && !unresolved) || e.hasIdempotencyKey || effectiveGuards(e).length > 0) continue;
      // Reported by their own rules: incrementing-write-unguarded, queue-add-without-job-id.
      if (isRelativeWrite(e) || (e.kind === "enqueue" && e.acceptsIdempotencyKey)) continue;
      const hollow = e.protectedBy.find((g) => g.kind === "unique-insert" && g.atomic === false);
      const hollowNote = hollow ? `; ${hollow.description} has no unique constraint${hollow.schemaSource ? ` in ${hollow.schemaSource}` : ""}, so it does not stop duplicates` : "";
      const story = deliveryNarrative(report.handler);
      const via = e.path.length ? ` (via ${e.path.map((p) => `${p.file}:${p.line}`).join(" → ")})` : "";
      out.push({
        rule: this.id,
        severity: this.severity,
        // Deep call chains are more likely to hide a guard we did not model.
        confidence: unresolved ? "low" : e.path.length <= 1 ? "high" : "medium",
        handler: report.handler.id,
        location: e.location,
        effect: e,
        message: `${e.kind} \`${e.callee}\`${e.note ? ` (${e.note})` : ""} has no guard on this path${via}${hollowNote}`,
        failingSequence: [
          `${story.first}; handler runs ${e.callee}`,
          story.retry,
          `Handler runs ${e.callee} again: ${consequence(e)}`,
        ],
        fix: fix(e, report.handler),
        snippet: e.acceptsIdempotencyKey
          ? SNIPPETS.idempotencyKey(e.acceptsIdempotencyKey.field, stableId(report.handler))
          : e.kind === "db-write"
            ? transactionalClaim(e.module)
            : SNIPPETS.releasableClaim,
      });
    }
    return out;
  },
};
