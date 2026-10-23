import type { HandlerReport } from "../types";
import { at, providerName, type Rule, type RuleFinding } from "./shared";

const SERVERLESS = new Set(["next-app-router", "next-pages-api", "aws-lambda", "next-server-action"]);
const NETWORK = new Set(["payment", "email", "sms", "http-call", "enqueue"]);

export const ackTiming: Rule = {
  id: "ack-timing",
  severity: "warning",
  docs: {
    summary: "The response is sent before the work completes (or the work is not awaited), or slow work delays the response past the provider's timeout.",
    why: "Once the provider has a 2xx it will not retry, so failures after the acknowledgement lose the event; on serverless the function may be frozen mid-work. Conversely, a slow response makes the provider time out and retry while the first attempt is still running.",
    safePattern: "Either do the work and then respond, or persist the event (or enqueue a job) and respond immediately, doing the work in a worker that has its own retries.",
  },
  run(report: HandlerReport): RuleFinding[] {
    const out: RuleFinding[] = [];
    const serverless = SERVERLESS.has(report.handler.framework);
    const p = providerName(report.handler);

    const ack = report.responses.find((r) => r.topLevel && r.status < 300 && !r.implicit);
    if (ack) {
      const after = report.effects.filter((e) => e.order > ack.order && e.kind !== "unknown");
      if (after.length) {
        out.push({
          rule: this.id,
          severity: this.severity,
          confidence: "high",
          handler: report.handler.id,
          location: ack.location,
          effect: after[0],
          message: `The handler responds ${ack.status} before ${after.map((e) => e.callee).slice(0, 2).join(" and ")} (${at(after[0]!.location)}); if that work fails, ${p} has already been told the event succeeded`,
          failingSequence: [`${p} delivers the event; the handler responds ${ack.status}`, `${after[0]!.callee} then fails or the process restarts`, "No retry comes: the event is lost"],
          fix: "Respond after the work completes, or persist the event/enqueue a job before responding and do the work there.",
        });
      }
    }

    for (const e of report.effects) {
      if (!e.floating || e.kind === "unknown") continue;
      out.push({
        rule: this.id,
        severity: this.severity,
        confidence: serverless ? "high" : "medium",
        handler: report.handler.id,
        location: e.path[0] ?? e.location,
        effect: e,
        message: `${e.callee} is not awaited${serverless ? "; the platform may freeze the function after the response, cutting it off" : "; its failure is never seen and the event is acknowledged anyway"}`,
        failingSequence: ["The handler starts the call without awaiting it and returns", serverless ? "The runtime suspends the function before the call finishes" : "The call rejects after the response was sent", "The work is lost and nothing retries it"],
        fix: serverless ? "Await the call (use Promise.all for parallel work), or hand it to waitUntil()/after() or a queue." : "Await the call (use Promise.all with for...of instead of forEach(async ...)).",
      });
    }

    const firstOk = report.responses.find((r) => r.status < 300);
    const before = report.effects.filter((e) => NETWORK.has(e.kind) && !e.floating && (!firstOk || e.order < firstOk.order));
    if (report.handler.kind === "http-webhook" && before.length >= 4) {
      out.push({
        rule: this.id,
        severity: this.severity,
        confidence: "low",
        handler: report.handler.id,
        location: before[0]!.location,
        message: `${before.length} network calls run before the response; a slow run can exceed ${p}'s timeout and trigger a retry while the first attempt is still working`,
        failingSequence: [`${p} delivers the event`, "The handler is still making network calls when the provider's timeout passes", `${p} retries; two attempts now run concurrently`],
        fix: "Persist the event and respond quickly, then process it from a queue.",
      });
    }
    return out;
  },
};
