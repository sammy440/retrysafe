import type { HandlerReport, KeySource } from "../types";
import { SNIPPETS, consequence, deliveryNarrative, type Rule, type RuleFinding } from "./shared";

export const nondeterministicKey: Rule = {
  id: "nondeterministic-key",
  severity: "error",
  docs: {
    summary: "A dedupe or idempotency key is derived from Date.now(), Math.random(), uuid(), or similar.",
    why: "The key is different on every delivery, so neither the guard nor the provider recognizes the retry as a duplicate.",
    safePattern: "Build keys only from values that are identical on every delivery: the provider's event id, the job id, or a business id from the payload.",
  },
  run(report: HandlerReport): RuleFinding[] {
    const out: RuleFinding[] = [];
    const story = deliveryNarrative(report.handler);
    const stable = report.handler.kind === "queue-worker" ? "job.id (or a business id from job.data)" : "the event id from the payload";

    const report1 = (src: KeySource, what: string, sequenceEnd: string) => {
      out.push({
        rule: this.id,
        severity: this.severity,
        confidence: "high",
        handler: report.handler.id,
        location: src.location,
        message: `${what} is built from ${src.text}; each retry gets a different key`,
        failingSequence: [`${story.first}; the key includes ${src.text}`, story.retry, `The retry computes a new key, so ${sequenceEnd}`],
        fix: `Derive the key only from values that are the same on every delivery, such as ${stable}.`,
        snippet: SNIPPETS.stableKey,
      });
    };

    for (const e of report.effects) {
      for (const src of e.keySources ?? []) {
        if (src.kind !== "nondeterministic") continue;
        report1(src, `Idempotency key for \`${e.callee}\``, `the provider treats it as a new request: ${consequence(e)}`);
      }
    }
    for (const g of report.guards) {
      for (const src of g.keySources ?? []) {
        if (src.kind !== "nondeterministic") continue;
        report1(src, `Dedupe key for ${g.description}`, "the guard sees an unseen key and lets the duplicate through");
      }
    }
    return out;
  },
};
