import type { EffectKind, KeySpec } from "../types";

/**
 * How to decide idempotency beyond a fixed value:
 * - "prisma-write": inspect `data` for increment/decrement/push, `skipDuplicates`
 * - "sql": inspect the SQL text (INSERT without ON CONFLICT, `x = x + 1`, ...)
 */
export type Classifier = "prisma-write" | "sql";

export interface EffectCatalogEntry {
  match: {
    module: string | string[];
    /** Dot-separated member chain matched against the end of the call's chain. `*` matches one segment. */
    callee: string;
  };
  kind: EffectKind;
  idempotent: boolean | "unknown";
  acceptsKey?: KeySpec;
  classify?: Classifier;
  /** Documentation backing the idempotency/key facts. */
  source?: string;
}

export interface VerifyCatalogEntry {
  match: { module: string | string[]; callee: string };
  provider?: string;
}

const STRIPE_KEY: KeySpec = { arg: 1, field: "idempotencyKey" };
const STRIPE_SRC = "https://docs.stripe.com/api/idempotent_requests";

const stripe = (callee: string): EffectCatalogEntry => ({
  match: { module: "stripe", callee },
  kind: "payment",
  idempotent: false,
  acceptsKey: STRIPE_KEY,
  source: STRIPE_SRC,
});

const PRISMA = "@prisma/client";
const SQL_CLIENTS = ["pg", "mysql2", "mysql2/promise"];
const REDIS = ["ioredis", "redis", "@upstash/redis"];

export const EFFECT_CATALOG: EffectCatalogEntry[] = [
  // Payments
  stripe("paymentIntents.create"),
  stripe("paymentIntents.confirm"),
  stripe("paymentIntents.capture"),
  stripe("charges.create"),
  stripe("refunds.create"),
  stripe("transfers.create"),
  stripe("payouts.create"),
  stripe("customers.create"),
  stripe("subscriptions.create"),
  stripe("invoices.create"),
  stripe("invoices.pay"),
  stripe("invoiceItems.create"),

  // Databases
  { match: { module: PRISMA, callee: "*.create" }, kind: "db-write", idempotent: false, classify: "prisma-write" },
  { match: { module: PRISMA, callee: "*.createMany" }, kind: "db-write", idempotent: false, classify: "prisma-write" },
  { match: { module: PRISMA, callee: "*.upsert" }, kind: "db-write", idempotent: true, classify: "prisma-write" },
  { match: { module: PRISMA, callee: "*.update" }, kind: "db-write", idempotent: true, classify: "prisma-write" },
  { match: { module: PRISMA, callee: "*.updateMany" }, kind: "db-write", idempotent: true, classify: "prisma-write" },
  { match: { module: PRISMA, callee: "*.delete" }, kind: "db-write", idempotent: true },
  { match: { module: PRISMA, callee: "*.deleteMany" }, kind: "db-write", idempotent: true },
  { match: { module: PRISMA, callee: "$executeRaw" }, kind: "db-write", idempotent: "unknown", classify: "sql" },
  { match: { module: PRISMA, callee: "$executeRawUnsafe" }, kind: "db-write", idempotent: "unknown", classify: "sql" },
  { match: { module: SQL_CLIENTS, callee: "query" }, kind: "db-write", idempotent: "unknown", classify: "sql" },
  { match: { module: SQL_CLIENTS, callee: "execute" }, kind: "db-write", idempotent: "unknown", classify: "sql" },
  { match: { module: REDIS, callee: "incr" }, kind: "db-write", idempotent: false },
  { match: { module: REDIS, callee: "incrby" }, kind: "db-write", idempotent: false },
  { match: { module: REDIS, callee: "incrbyfloat" }, kind: "db-write", idempotent: false },
  { match: { module: REDIS, callee: "hincrby" }, kind: "db-write", idempotent: false },
  { match: { module: REDIS, callee: "lpush" }, kind: "db-write", idempotent: false },
  { match: { module: REDIS, callee: "rpush" }, kind: "db-write", idempotent: false },
  { match: { module: REDIS, callee: "xadd" }, kind: "db-write", idempotent: false },

  // Email and SMS
  { match: { module: "nodemailer", callee: "sendMail" }, kind: "email", idempotent: false },
  {
    match: { module: "resend", callee: "emails.send" },
    kind: "email",
    idempotent: false,
    acceptsKey: { arg: 1, field: "idempotencyKey" },
    source: "https://resend.com/docs/dashboard/emails/idempotency-keys",
  },
  { match: { module: "@sendgrid/mail", callee: "send" }, kind: "email", idempotent: false },
  { match: { module: "@sendgrid/mail", callee: "sendMultiple" }, kind: "email", idempotent: false },
  { match: { module: "postmark", callee: "sendEmail" }, kind: "email", idempotent: false },
  { match: { module: "twilio", callee: "messages.create" }, kind: "sms", idempotent: false },

  // Queues
  {
    match: { module: ["bullmq", "bull"], callee: "add" },
    kind: "enqueue",
    idempotent: false,
    acceptsKey: { arg: 2, field: "jobId" },
    source: "https://docs.bullmq.io/guide/jobs/job-ids",
  },

  // Outbound HTTP: repeatable or not depends on the remote side.
  { match: { module: "axios", callee: "post" }, kind: "http-call", idempotent: "unknown" },
  { match: { module: "axios", callee: "patch" }, kind: "http-call", idempotent: "unknown" },
];

export const VERIFY_CATALOG: VerifyCatalogEntry[] = [
  { match: { module: "stripe", callee: "webhooks.constructEvent" }, provider: "stripe" },
  { match: { module: "stripe", callee: "webhooks.constructEventAsync" }, provider: "stripe" },
  { match: { module: "svix", callee: "verify" } },
  { match: { module: "standardwebhooks", callee: "verify" } },
  { match: { module: "@octokit/webhooks", callee: "verify" }, provider: "github" },
  { match: { module: "@octokit/webhooks", callee: "verifyAndReceive" }, provider: "github" },
  { match: { module: "@shopify/shopify-api", callee: "webhooks.validate" }, provider: "shopify" },
  { match: { module: "crypto", callee: "createHmac" } },
  { match: { module: "crypto", callee: "timingSafeEqual" } },
];

/** Models and tables whose names suggest they record processed events. */
export const DEDUPE_NAME = /processed|dedup|idempot|webhook_?events?|inbox|seen_?events?/i;

export function chainMatches(pattern: string, chain: string[]): boolean {
  const parts = pattern.split(".");
  if (chain.length < parts.length) return false;
  const tail = chain.slice(chain.length - parts.length);
  return parts.every((p, i) => p === "*" || p === tail[i]);
}

export function moduleMatches(m: string | string[], module: string): boolean {
  return Array.isArray(m) ? m.includes(module) : m === module;
}

export function findEntry<T extends { match: { module: string | string[]; callee: string } }>(
  catalog: T[],
  module: string,
  chain: string[],
): T | undefined {
  return catalog.find((e) => moduleMatches(e.match.module, module) && chainMatches(e.match.callee, chain));
}

export const REDIS_MODULES = REDIS;
export const SQL_MODULES = SQL_CLIENTS;
export const PRISMA_MODULE = PRISMA;
