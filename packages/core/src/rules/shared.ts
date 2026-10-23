import { createHash } from "node:crypto";
import type { Effect, Finding, Guard, Handler, HandlerReport, Severity, SourceLocation } from "../types";

export type RuleFinding = Omit<Finding, "id">;

export interface RuleDocs {
  summary: string;
  why: string;
  safePattern: string;
}

export interface Rule {
  id: string;
  severity: Severity;
  docs: RuleDocs;
  run(report: HandlerReport): RuleFinding[];
}

export function fingerprint(parts: string[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 8);
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

export function stableId(h: Handler): string {
  return h.kind === "queue-worker" ? "job.id" : "event.id";
}

export function effectiveGuards(e: Effect): Guard[] {
  return e.protectedBy.filter((g) => !(g.kind === "unique-insert" && g.atomic === false));
}

export const at = (l: SourceLocation) => `${l.file}:${l.line}`;

export function sameTransaction(a: { transaction?: string }, b: { transaction?: string }): boolean {
  return !!a.transaction && a.transaction === b.transaction;
}

const TX_CLAIM: Record<string, string> = {
  prisma: `await prisma.$transaction(async (tx) => {
  // processedEvent.id has a unique constraint: a retry throws here and nothing below commits twice.
  await tx.processedEvent.create({ data: { id: event.id } });
  // ...this handler's writes, using tx...
});`,
  drizzle: `await db.transaction(async (tx) => {
  const [claimed] = await tx.insert(processedEvents).values({ id: event.id }).onConflictDoNothing().returning();
  if (!claimed) return; // duplicate delivery
  // ...this handler's writes, using tx...
});`,
  knex: `await knex.transaction(async (trx) => {
  const claimed = await trx("processed_events").insert({ id: event.id }).onConflict("id").ignore().returning("id");
  if (claimed.length === 0) return; // duplicate delivery
  // ...this handler's writes, using trx...
});`,
  mongoose: `await mongoose.connection.transaction(async (session) => {
  // _id is unique: a retry throws E11000 here and nothing below commits twice.
  await ProcessedEvent.create([{ _id: event.id }], { session });
  // ...this handler's writes, passing { session }...
});`,
  dynamo: `await dynamo.send(new TransactWriteItemsCommand({
  ClientRequestToken: event.id,
  TransactItems: [
    { Put: { TableName: "processed", Item: { pk: { S: event.id } }, ConditionExpression: "attribute_not_exists(pk)" } },
    // ...this handler's writes as further Put/Update items...
  ],
}));`,
  sql: `await client.query("BEGIN");
const claim = await client.query("INSERT INTO processed_events (id) VALUES ($1) ON CONFLICT DO NOTHING", [event.id]);
if (claim.rowCount === 0) { await client.query("ROLLBACK"); return; } // duplicate delivery
// ...this handler's writes on the same client...
await client.query("COMMIT");`,
};

export function transactionalClaim(module: string): string {
  if (module.startsWith("drizzle-orm")) return TX_CLAIM.drizzle!;
  if (module === "knex") return TX_CLAIM.knex!;
  if (module === "mongoose") return TX_CLAIM.mongoose!;
  if (module.startsWith("@aws-sdk/client-dynamodb") || module === "@aws-sdk/lib-dynamodb") return TX_CLAIM.dynamo!;
  if (["pg", "mysql2", "mysql2/promise", "@neondatabase/serverless", "@vercel/postgres"].includes(module)) return TX_CLAIM.sql!;
  return TX_CLAIM.prisma!;
}

export const SNIPPETS = {
  idempotencyKey: (field: string, id = "event.id") => `await client.call(params, { ${field}: \`evt_\${${id}}\` });`,
  releasableClaim: `const key = \`evt:\${event.id}\`;
if (!(await redis.set(key, "1", "EX", 60 * 60 * 24 * 7, "NX"))) return ok(); // duplicate
try {
  await doTheWork();
} catch (err) {
  await redis.del(key); // let the retry try again
  throw err;
}`,
  stableKey: `idempotencyKey: \`payout_\${event.id}\` // same value on every delivery`,
};
