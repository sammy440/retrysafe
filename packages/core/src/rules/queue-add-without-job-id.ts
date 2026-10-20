import type { HandlerReport } from "../types";
import { stableId, type Rule, type RuleFinding } from "./shared";

/** Enqueuing from a handler without the queue's deduplication id. */
export const queueAddWithoutJobId: Rule = {
  id: "queue-add-without-job-id",
  severity: "info",
  docs: {
    summary: "A job or message is enqueued without the queue's deduplication id (jobId, MessageDeduplicationId, event id).",
    why: "When the handler is redelivered it enqueues the work again, and the downstream job runs twice.",
    safePattern: "Set the queue's deduplication id from the event id so a redelivery enqueues nothing new.",
  },
  run(report: HandlerReport): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const e of report.effects) {
      if (e.kind !== "enqueue" || !e.acceptsIdempotencyKey || e.hasIdempotencyKey) continue;
      const field = e.acceptsIdempotencyKey.field;
      out.push({
        rule: this.id,
        severity: this.severity,
        confidence: "high",
        handler: report.handler.id,
        location: e.location,
        effect: e,
        message: `${e.callee} enqueues without ${field}; a redelivered ${report.handler.kind === "queue-worker" ? "job" : "event"} enqueues the work again`,
        failingSequence: ["The handler enqueues a job", "The handler is redelivered", "A second, identical job is enqueued and runs"],
        fix: `Pass ${field} derived from ${stableId(report.handler)}${field === "MessageDeduplicationId" ? " (FIFO queues only)" : ""}.`,
        snippet: field === "jobId" ? `await queue.add("name", data, { jobId: \`followup-\${${stableId(report.handler)}}\` });` : undefined,
      });
    }
    return out;
  },
};
