import type { HandlerReport } from "../types";
import { deliveryNarrative, providerName, type Rule, type RuleFinding } from "./shared";

/** A catch block logs the error and acknowledges anyway, so the provider never retries and the event is lost. */
export const swallowedErrorReturns2xx: Rule = {
  id: "swallowed-error-returns-2xx",
  severity: "error",
  docs: {
    summary: "A catch block swallows a failure of the handler's work and still acknowledges the event (2xx, or a completed job).",
    why: "Retries are the provider's recovery mechanism. Answering 2xx after the work failed tells it the event was handled, so the event is never delivered again.",
    safePattern: "Rethrow (or answer 5xx) when the work fails so the provider retries; only answer 2xx for duplicates or permanent payload errors you have recorded.",
  },
  run(report: HandlerReport): RuleFinding[] {
    const out: RuleFinding[] = [];
    const queue = report.handler.kind === "queue-worker" || report.handler.kind === "serverless";
    for (const c of report.catches) {
      if (c.rethrows || c.reportsFailure || c.tryEffects === 0) continue;
      if (c.statuses.some((s) => s >= 400)) continue;
      const explicit = c.statuses.some((s) => s < 300);
      // An HTTP catch that neither responds nor rethrows falls through to the handler's success path.
      const effect = c.tryEffectCallees[0]!;
      const story = deliveryNarrative(report.handler);
      out.push({
        rule: this.id,
        severity: this.severity,
        confidence: explicit || queue ? (c.depth === 0 ? "high" : "medium") : "medium",
        handler: report.handler.id,
        location: c.location,
        message: queue
          ? `A failure of ${effect} is caught and not rethrown, so the ${report.handler.kind === "queue-worker" ? "job is marked completed" : "message is deleted"} and never retried`
          : `A failure of ${effect} is caught and answered with ${explicit ? "a 2xx" : "the normal success response"}; ${providerName(report.handler)} will not retry`,
        failingSequence: [
          `${story.first}; ${effect} fails (timeout, outage, constraint error)`,
          queue ? "The catch block swallows the error and the job finishes normally" : `The catch block logs it and responds ${explicit ? c.statuses.find((s) => s < 300) : 200}`,
          "No retry is ever delivered: the event is lost",
        ],
        fix: queue
          ? "Rethrow after logging so the queue retries the job (or report the record in batchItemFailures for SQS batches)."
          : "Rethrow, or respond 500, when the work fails; respond 2xx only for duplicates and recorded permanent errors.",
        snippet: queue
          ? "} catch (err) {\n  logger.error(err);\n  throw err; // let the queue retry\n}"
          : "} catch (err) {\n  logger.error(err);\n  return res.sendStatus(500); // the provider will retry\n}",
      });
    }
    return out;
  },
};
