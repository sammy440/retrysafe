import type { Effect, HandlerReport } from "../types";
import { at, transactionalClaim, type Rule, type RuleFinding } from "./shared";

function sameLine(a: Effect, b: Effect): boolean {
  const [short, long] = a.branch.length <= b.branch.length ? [a.branch, b.branch] : [b.branch, a.branch];
  return short.every((x, i) => long[i] === x);
}

export const nonAtomicMultiWrite: Rule = {
  id: "non-atomic-multi-write",
  severity: "warning",
  docs: {
    summary: "Several database writes on one path run outside a transaction, and at least one is not idempotent.",
    why: "If the handler fails between the writes, the first is committed and the rest are not. The retry then runs the first write again (duplicating it) or trips over its result.",
    safePattern: "Wrap the writes (and the processed-event claim) in one transaction.",
  },
  run(report: HandlerReport): RuleFinding[] {
    const writes = report.effects.filter((e) => e.kind === "db-write" && !e.transaction && !e.floating);
    for (let i = 1; i < writes.length; i++) {
      const second = writes[i]!;
      const together = writes.slice(0, i + 1).filter((w) => sameLine(w, second));
      if (together.length < 2 || !together.some((w) => w.idempotent === false)) continue;
      const first = together[0]!;
      return [
        {
          rule: this.id,
          severity: this.severity,
          confidence: "medium",
          handler: report.handler.id,
          location: second.location,
          effect: second,
          message: `${together.length} writes (${first.callee} at ${at(first.location)}, ${second.callee}) commit separately; a failure between them plus a retry leaves partial or duplicated state`,
          failingSequence: [`The handler commits ${first.callee}`, `It fails before ${second.callee}`, `The retry runs ${first.callee} again on top of the committed result`],
          fix: "Run these writes in a single transaction (together with the processed-event claim).",
          snippet: transactionalClaim(second.module),
        },
      ];
    }
    return [];
  },
};
