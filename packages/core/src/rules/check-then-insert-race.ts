import type { HandlerReport } from "../types";
import { at, consequence, effectiveGuards, transactionalClaim, type Rule, type RuleFinding } from "./shared";

export const checkThenInsertRace: Rule = {
  id: "check-then-insert-race",
  severity: "error",
  docs: {
    summary: "A lookup-then-insert dedupe check with no atomic claim before the effect; concurrent duplicates both pass it.",
    why: "Providers can deliver the same event twice at nearly the same instant (retries racing a slow first attempt, multiple workers). Both copies read 'not processed' before either writes the record.",
    safePattern: "Replace the lookup with an atomic claim: insert the event id into a table with a unique constraint (or Redis SET NX) and proceed only if the claim succeeded.",
  },
  run(report: HandlerReport): RuleFinding[] {
    if (report.handler.serialized) return [];
    const out: RuleFinding[] = [];
    const reported = new Set<string>();
    for (const e of report.effects) {
      if (e.idempotent !== false || e.hasIdempotencyKey) continue;
      const guards = effectiveGuards(e);
      const lookup = guards.find((g) => g.kind === "lookup-then-insert");
      if (!lookup || guards.some((g) => g.kind !== "lookup-then-insert")) continue;
      const key = `${lookup.location.file}:${lookup.location.line}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const record = report.records.find((r) => r.order > e.order && r.guard?.table && lookup.table && r.guard.table === lookup.table);
      const schemaSays = record?.guard?.schema;
      out.push({
        rule: this.id,
        severity: this.severity,
        confidence: schemaSays === "no-unique-constraint" ? "high" : "medium",
        handler: report.handler.id,
        location: lookup.location,
        effect: e,
        message:
          `Dedupe check (${lookup.description}) is not atomic: two concurrent deliveries can both pass it before either is recorded, ` +
          `then both run ${e.callee} (${at(e.location)})` +
          (schemaSays === "no-unique-constraint" ? `; ${record!.guard!.table} has no unique constraint in ${record!.guard!.schemaSource ?? "the schema"}` : ""),
        failingSequence: [
          "Deliveries A and B of the same event arrive at the same time",
          `A and B both run ${lookup.description} and find no record`,
          `A and B both run ${e.callee}: ${consequence(e)}`,
        ],
        fix: "Claim the event atomically instead of looking it up: insert its id into a table with a unique constraint (or Redis SET NX) before the work, and skip when the claim fails.",
        snippet: transactionalClaim(e.module),
      });
    }
    return out;
  },
};
