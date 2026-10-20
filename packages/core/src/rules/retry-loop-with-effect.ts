import type { HandlerReport } from "../types";
import { at, type Rule, type RuleFinding } from "./shared";

/** In-code retry around a non-idempotent call: a timeout after the provider succeeded is retried into a duplicate. */
export const retryLoopWithEffect: Rule = {
  id: "retry-loop-with-effect",
  severity: "warning",
  docs: {
    summary: "An in-code retry (loop, p-retry, async-retry) wraps a non-idempotent call that has no stable idempotency key.",
    why: "A timeout does not mean the call failed: the remote side may have done the work. Retrying it without a key repeats the effect.",
    safePattern: "Pass an idempotency key that stays the same across attempts, or only retry calls that are idempotent.",
  },
  run(report: HandlerReport): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const e of report.effects) {
      if (!e.retriedBy || e.idempotent !== false || e.hasIdempotencyKey) continue;
      out.push({
        rule: this.id,
        severity: this.severity,
        confidence: "high",
        handler: report.handler.id,
        location: e.location,
        effect: e,
        message: `${e.callee} is retried in code (${at(e.retriedBy)}) without an idempotency key; a timed-out attempt that actually succeeded is repeated`,
        failingSequence: [`Attempt 1 of ${e.callee} reaches the provider and succeeds`, "The response times out before reaching the handler", `The retry wrapper calls ${e.callee} again: the effect happens twice`],
        fix: e.acceptsIdempotencyKey
          ? `Pass ${e.acceptsIdempotencyKey.field}, computed once outside the retry, so every attempt uses the same key.`
          : "Remove the in-code retry for this call (let the queue or provider retry the whole, guarded handler), or make the call idempotent.",
      });
    }
    return out;
  },
};
