import type { Effect, Finding, Handler, HandlerReport } from "../types";
import { SNIPPETS, consequence, deliveryNarrative, findingId, stableId, type Rule } from "./shared";

function fix(e: Effect, h: Handler): string {
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
  run(report: HandlerReport): Finding[] {
    const out: Finding[] = [];
    for (const e of report.effects) {
      if (e.idempotent !== false || e.hasIdempotencyKey || e.protectedBy.length > 0) continue;
      const story = deliveryNarrative(report.handler);
      const via = e.path.length ? ` (via ${e.path.map((p) => `${p.file}:${p.line}`).join(" → ")})` : "";
      out.push({
        id: findingId(this.id, report.handler.id, e.location),
        rule: this.id,
        severity: this.severity,
        // Deep call chains are more likely to hide a guard we did not model.
        confidence: e.path.length <= 1 ? "high" : "medium",
        handler: report.handler.id,
        location: e.location,
        effect: e,
        message: `${e.kind} \`${e.callee}\`${e.note ? ` (${e.note})` : ""} has no guard on this path${via}`,
        failingSequence: [
          `${story.first}; handler runs ${e.callee}`,
          story.retry,
          `Handler runs ${e.callee} again: ${consequence(e)}`,
        ],
        fix: fix(e, report.handler),
        snippet: e.acceptsIdempotencyKey
          ? SNIPPETS.idempotencyKey(e.acceptsIdempotencyKey.field, stableId(report.handler))
          : e.kind === "db-write"
            ? SNIPPETS.transactionalClaim
            : SNIPPETS.releasableClaim,
      });
    }
    return out;
  },
};
