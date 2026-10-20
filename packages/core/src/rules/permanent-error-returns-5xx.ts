import type { HandlerReport } from "../types";
import { providerName, type Rule, type RuleFinding } from "./shared";

/** A bad signature or malformed payload answered with 5xx: the provider retries something that can never succeed. */
export const permanentErrorReturns5xx: Rule = {
  id: "permanent-error-returns-5xx",
  severity: "warning",
  docs: {
    summary: "A permanent failure (invalid signature, malformed payload) is answered with 5xx, causing pointless retries.",
    why: "Providers retry 5xx responses for hours or days. A request that failed validation will fail the same way every time, wasting retries and possibly getting the endpoint disabled.",
    safePattern: "Answer 400 for malformed payloads and 400/401 for bad signatures; reserve 5xx for transient failures worth retrying.",
  },
  run(report: HandlerReport): RuleFinding[] {
    if (report.handler.kind !== "http-webhook") return [];
    const out: RuleFinding[] = [];
    for (const r of report.responses) {
      if (r.status < 500 || (r.reason !== "signature" && r.reason !== "validation")) continue;
      const what = r.reason === "signature" ? "signature verification failure" : "invalid payload";
      out.push({
        rule: this.id,
        severity: this.severity,
        confidence: r.implicit ? "medium" : "high",
        handler: report.handler.id,
        location: r.location,
        message: `A ${what} is answered with ${r.status}${r.implicit ? " (uncaught throw)" : ""}; ${providerName(report.handler)} will keep retrying a request that cannot succeed`,
        failingSequence: [
          `A delivery arrives with a ${what}`,
          `The handler answers ${r.status}`,
          `${providerName(report.handler)} retries the same request on its backoff schedule, failing identically each time`,
        ],
        fix: r.reason === "signature" ? "Respond 400 (or 401) when the signature does not verify." : "Respond 400 for payloads that fail validation, after logging them.",
        snippet: r.reason === "signature" ? 'return res.status(400).send("invalid signature");' : 'return res.status(400).json({ error: "invalid payload" });',
      });
    }
    return out;
  },
};
