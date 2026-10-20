import type { HandlerReport } from "../types";
import { providerName, type Rule, type RuleFinding } from "./shared";

function human(seconds: number): string {
  return seconds >= 86400 ? `${+(seconds / 86400).toFixed(1)}d` : seconds >= 3600 ? `${+(seconds / 3600).toFixed(1)}h` : `${Math.round(seconds / 60)}m`;
}

/** Dedupe keys that expire before the provider stops retrying. */
export const dedupeTtlShort: Rule = {
  id: "dedupe-ttl-short",
  severity: "warning",
  docs: {
    summary: "A dedupe key expires sooner than the provider's retry window.",
    why: "A retry that arrives after the key has expired is treated as a new event and processed again.",
    safePattern: "Keep dedupe keys at least as long as the provider retries (configure providers.<name>.retryWindowHours), or store them durably.",
  },
  run(report: HandlerReport): RuleFinding[] {
    const windowHours = report.handler.retryWindowHours;
    if (!windowHours) return [];
    const windowSeconds = windowHours * 3600;
    const out: RuleFinding[] = [];
    const items = [
      ...report.guards.filter((g) => g.kind === "redis-setnx").map((g) => ({ ttl: g.ttlSeconds, location: g.location, what: g.description })),
      ...report.records.filter((r) => r.kind === "marker-write").map((r) => ({ ttl: r.ttlSeconds, location: r.location, what: r.description })),
    ];
    for (const i of items) {
      if (i.ttl === undefined || i.ttl >= windowSeconds) continue;
      out.push({
        rule: this.id,
        severity: this.severity,
        confidence: "high",
        handler: report.handler.id,
        location: i.location,
        message: `${i.what} expires after ${human(i.ttl)}, but ${providerName(report.handler)} retries for up to ${human(windowSeconds)}`,
        failingSequence: [`The event is processed and its key stored for ${human(i.ttl)}`, `${providerName(report.handler)} retries after the key expired`, "The retry is processed again"],
        fix: `Set the expiry to at least ${human(windowSeconds)} (adjust providers.${report.handler.provider}.retryWindowHours if your provider differs).`,
      });
    }
    return out;
  },
};
