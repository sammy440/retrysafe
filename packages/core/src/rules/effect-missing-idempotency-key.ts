import type { HandlerReport } from "../types";
import { SNIPPETS, stableId, type Rule, type RuleFinding } from "./shared";

const KINDS = new Set(["payment", "email", "sms"]);

export const effectMissingIdempotencyKey: Rule = {
  id: "effect-missing-idempotency-key",
  severity: "warning",
  docs: {
    summary: "A call whose SDK supports an idempotency key is made without one.",
    why: "Guards can still let a repeat through (record rolled back with the transaction, lease expired, non-atomic check). Without a key the provider performs the effect again.",
    safePattern: "Pass the SDK's idempotency key option, derived from the event or job id.",
  },
  run(report: HandlerReport): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const e of report.effects) {
      const spec = e.acceptsIdempotencyKey;
      if (!spec || e.hasIdempotencyKey || !KINDS.has(e.kind) || e.protectedBy.length === 0) continue;
      out.push({
        rule: this.id,
        severity: this.severity,
        confidence: "medium",
        handler: report.handler.id,
        location: e.location,
        effect: e,
        message: `\`${e.callee}\` supports \`${spec.field}\` but none is passed`,
        failingSequence: [
          `The handler passes its guard and runs ${e.callee}`,
          "The process dies after the provider accepts the call but before the handler's own state is committed",
          "The retry gets past the guard (record rolled back, lease expired, or check not atomic) and repeats the call",
        ],
        fix: `Pass { ${spec.field}: <stable id derived from the event> } as argument ${spec.arg + 1}; the provider then returns the original result instead of repeating the effect.`,
        snippet: SNIPPETS.idempotencyKey(spec.field, stableId(report.handler)),
      });
    }
    return out;
  },
};
