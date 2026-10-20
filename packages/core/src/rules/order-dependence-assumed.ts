import type { HandlerReport } from "../types";
import type { Rule, RuleFinding } from "./shared";

const STATE_FIELD = /^(status|state|stage|phase|plan|tier|active|isActive|cancel\w*|subscriptionStatus|paymentStatus)$/i;

/** State overwritten from several event types with no version or timestamp check. */
export const orderDependenceAssumed: Rule = {
  id: "order-dependence-assumed",
  severity: "info",
  docs: {
    summary: "The handler sets state from several event types without checking a version or timestamp.",
    why: "Webhooks are not delivered in order. A delayed 'subscription.updated' can arrive after 'subscription.deleted' and resurrect the subscription.",
    safePattern: "Store the event's timestamp or version with the state and ignore events older than what is stored, or fetch the current object from the provider before writing.",
  },
  run(report: HandlerReport): RuleFinding[] {
    if (report.handler.kind !== "http-webhook" || report.eventTypes.length < 2 || report.checksOrdering) return [];
    const write = report.effects.find((e) => e.kind === "db-write" && e.idempotent === true && e.fields?.some((f) => STATE_FIELD.test(f)));
    if (!write) return [];
    return [
      {
        rule: this.id,
        severity: this.severity,
        confidence: "low",
        handler: report.handler.id,
        location: write.location,
        effect: write,
        message: `${write.callee} sets ${write.fields!.filter((f) => STATE_FIELD.test(f)).join(", ")} for ${report.eventTypes.length} event types (${report.eventTypes.slice(0, 3).join(", ")}) without comparing a version or timestamp`,
        failingSequence: ["Event A (newer) and event B (older) are emitted for the same object", "B is delayed and arrives after A", "B overwrites A's state with stale data"],
        fix: "Compare the event's created timestamp (or the object's version) with the stored one and skip older events, or re-fetch the object from the provider before writing.",
      },
    ];
  },
};
