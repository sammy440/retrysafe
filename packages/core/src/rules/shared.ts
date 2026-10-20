import { createHash } from "node:crypto";
import type { Effect, Finding, Handler, HandlerReport, Severity, SourceLocation } from "../types";

export interface Rule {
  id: string;
  severity: Severity;
  run(report: HandlerReport): Finding[];
}

/** Stable across runs and unrelated edits elsewhere in the file's handler, so baselines can key on it. */
export function findingId(rule: string, handlerId: string, loc: SourceLocation): string {
  return createHash("sha1").update(`${rule}|${handlerId}|${loc.file}:${loc.line}`).digest("hex").slice(0, 8);
}

const PROVIDER_NAMES: Record<string, string> = {
  stripe: "Stripe",
  paystack: "Paystack",
  flutterwave: "Flutterwave",
  shopify: "Shopify",
  github: "GitHub",
  twilio: "Twilio",
  sendgrid: "SendGrid",
  resend: "Resend",
  clerk: "Clerk",
  paypal: "PayPal",
};

export function providerName(h: Handler): string {
  return (h.provider && PROVIDER_NAMES[h.provider]) ?? "The provider";
}

export function deliveryNarrative(h: Handler): { first: string; retry: string } {
  if (h.kind === "queue-worker") {
    return {
      first: "The worker picks up job 1",
      retry: "The worker crashes or the job lock expires before completion is recorded; the queue retries job 1",
    };
  }
  const p = providerName(h);
  const evt = h.provider === "stripe" ? "evt_1" : "event 1";
  return {
    first: `${p} delivers ${evt}`,
    retry: `The response is slow or the process restarts before ${p === "The provider" ? "the provider" : p} sees a 2xx; it retries ${evt}`,
  };
}

const CONSEQUENCE: Record<Effect["kind"], string> = {
  payment: "the customer is charged twice",
  email: "a second email is sent",
  sms: "a second SMS is sent",
  "db-write": "a duplicate row is written",
  enqueue: "a duplicate job is queued",
  "http-call": "the remote call is repeated",
  "file-write": "the file is written again",
  unknown: "the effect happens again",
};

export function consequence(e: Effect): string {
  if (e.kind === "db-write" && e.note && /increment|relative|push/i.test(e.note)) return "the value is applied twice";
  return CONSEQUENCE[e.kind];
}

/** The expression a fix should key on: the job id for workers, the provider's event id for webhooks. */
export function stableId(h: Handler): string {
  return h.kind === "queue-worker" ? "job.id" : "event.id";
}

export const at = (l: SourceLocation) => `${l.file}:${l.line}`;

/** Two steps commit together only if they run inside the same transaction. */
export function sameTransaction(a: { transaction?: string }, b: { transaction?: string }): boolean {
  return !!a.transaction && a.transaction === b.transaction;
}

/** Code for the safe patterns, referenced by fixes. Kept generic: Prisma for DB, Redis for claims. */
export const SNIPPETS = {
  transactionalClaim: `await prisma.$transaction(async (tx) => {
  // processedEvent.id has a unique constraint: a retry throws here and nothing below commits twice.
  await tx.processedEvent.create({ data: { id: event.id } });
  // ...this handler's writes, using tx...
});`,
  idempotencyKey: (field: string, id = "event.id") => `await client.call(params, { ${field}: \`evt_\${${id}}\` });`,
  releasableClaim: `const key = \`evt:\${event.id}\`;
if (!(await redis.set(key, "1", "EX", 60 * 60 * 24 * 7, "NX"))) return ok(); // duplicate
try {
  await sendTheEmail();
} catch (err) {
  await redis.del(key); // let the retry try again
  throw err;
}`,
  stableKey: `idempotencyKey: \`payout_\${event.id}\` // same value on every delivery`,
};
