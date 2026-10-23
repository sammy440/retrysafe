import type { HandlerReport, KeySource } from "../types";
import type { Rule, RuleFinding } from "./shared";

const OBJECT_ID = /\.data\.object\.(id|\w+_id)$|\.(resource|object)\.id$/i;
const DATA_ID = /\.data\.(id|\w+_id)$/i;
const EVENT_LEVEL = /(^|\.)(type|event_type|eventType)$|^(event|evt|webhookEvent|e|body|payload|req\.body)\.id$/i;

export const wrongEventFieldAsKey: Rule = {
  id: "wrong-event-field-as-key",
  severity: "warning",
  docs: {
    summary: "A dedupe key is derived from the object id inside the event (e.g. event.data.object.id) rather than the event id.",
    why: "Many events concern the same object (invoice.created, invoice.paid, invoice.voided). Keyed by the object id, the first one marks the object as processed and every later, distinct event is dropped as a duplicate.",
    safePattern: "Key processed-event records on the provider's event id (or delivery id header), or include the event type with the object id.",
  },
  run(report: HandlerReport): RuleFinding[] {
    if (report.handler.kind !== "http-webhook") return [];
    const out: RuleFinding[] = [];
    for (const g of report.guards) {
      const sources = (g.keySources ?? []).filter((s) => s.kind === "event-field");
      if (sources.some((s: KeySource) => EVENT_LEVEL.test(s.expanded ?? s.text))) continue;
      const strong = sources.find((s) => OBJECT_ID.test(s.expanded ?? s.text));
      const objectKey = strong ?? sources.find((s) => DATA_ID.test(s.expanded ?? s.text));
      if (!objectKey) continue;
      out.push({
        rule: this.id,
        severity: this.severity,
        confidence: strong ? "medium" : "low",
        handler: report.handler.id,
        location: objectKey.location,
        message: `Dedupe key for ${g.description} uses ${objectKey.text}${objectKey.expanded && objectKey.expanded !== objectKey.text ? ` (${objectKey.expanded})` : ""}, the object's id; later distinct events about the same object are dropped as duplicates`,
        failingSequence: [
          `An event about object X arrives; ${g.description} records X`,
          "A different event about the same object arrives (e.g. created, then paid)",
          "The guard finds X already recorded and skips it: the second event is lost",
        ],
        fix: "Key on the event id (event.id, or the delivery id header) instead, or combine the event type with the object id.",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is example source code, not a template
        snippet: "data: { id: event.id } // or `${event.type}:${event.data.object.id}`",
      });
    }
    return out;
  },
};
