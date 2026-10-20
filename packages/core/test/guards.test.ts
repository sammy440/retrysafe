import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { analyze, type AnalyzeOptions } from "../src";

const LIBS = {
  "/lib/db.ts": `import { PrismaClient } from "@prisma/client";\nexport const prisma = new PrismaClient();`,
  "/lib/redis.ts": `import Redis from "ioredis";\nexport const redis = new Redis();`,
  "/lib/stripe.ts": `import Stripe from "stripe";\nexport const stripe = new Stripe("k");`,
  "/lib/mail.ts": `import nodemailer from "nodemailer";\nconst t = nodemailer.createTransport({});\nexport const send = (to: string) => t.sendMail({ to });`,
};

/** Analyze a Next.js webhook route whose POST body is `body`. */
function run(body: string, opts: AnalyzeOptions = {}) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  for (const [file, src] of Object.entries(LIBS)) project.createSourceFile(file, src);
  project.createSourceFile(
    "/app/api/webhooks/test/route.ts",
    `import { prisma } from "../../../../lib/db";
import { redis } from "../../../../lib/redis";
import { send } from "../../../../lib/mail";
import { stripe } from "../../../../lib/stripe";
import { v4 } from "uuid";
export async function POST(req: Request) {
  const event: any = await req.json();
${body}
  return new Response("ok");
}`,
  );
  return analyze({ project, root: "/", ...opts });
}

const rules = (r: ReturnType<typeof run>) => r.findings.map((f) => f.rule);
/** Guard-detection tests only care whether the effect counts as guarded. */
const unguarded = (r: ReturnType<typeof run>) => rules(r).filter((x) => x === "unguarded-side-effect");

const EFFECT = `  await send(event.email);`;

describe("guard detection", () => {
  it("flags an unguarded effect, and clears it when a guard is added (mutation)", () => {
    expect(unguarded(run(EFFECT))).toEqual(["unguarded-side-effect"]);
    const guarded = `  if (!(await redis.set(event.id, "1", "NX"))) return new Response("dup");\n${EFFECT}`;
    expect(unguarded(run(guarded))).toEqual([]);
  });

  it("only protects effects after the guard, not before it", () => {
    const body = `${EFFECT}\n  const ok = await redis.set(event.id, "1", "NX");\n  if (!ok) return new Response("dup");`;
    expect(unguarded(run(body))).toEqual(["unguarded-side-effect"]);
  });

  it("treats a SET NX checked with the wrong polarity as no guard", () => {
    // Exits when the claim *succeeds*; the effect runs only for duplicates.
    const body = `  const ok = await redis.set(event.id, "1", "NX");\n  if (ok) return new Response("first");\n${EFFECT}`;
    expect(unguarded(run(body))).toEqual(["unguarded-side-effect"]);
  });

  it("accepts the positive form: work inside if (claimed) { ... }", () => {
    const body = `  const claimed = await redis.set(event.id, "1", "NX");\n  if (claimed) {\n  ${EFFECT}\n  }`;
    expect(unguarded(run(body))).toEqual([]);
  });

  it("does not treat a not-found check as a dedupe check", () => {
    const body = `  const user = await prisma.user.findUnique({ where: { id: event.userId } });\n  if (!user) return new Response("no user");\n${EFFECT}`;
    expect(unguarded(run(body))).toEqual(["unguarded-side-effect"]);
  });

  it("treats a lookup with early exit on found as a (non-atomic) guard", () => {
    const body = `  const seen = await prisma.processedEvent.findUnique({ where: { id: event.id } });\n  if (seen) return new Response("dup");\n${EFFECT}`;
    const r = run(body);
    expect(unguarded(r)).toEqual([]);
    expect(r.handlers[0]!.guards[0]).toMatchObject({ kind: "lookup-then-insert", atomic: false });
  });

  it("treats an insert into a processed-events table as a guard for what follows", () => {
    const body = `  await prisma.processedEvent.create({ data: { id: event.id } });\n${EFFECT}`;
    const r = run(body);
    expect(unguarded(r)).toEqual([]);
    expect(r.handlers[0]!.guards[0]).toMatchObject({ kind: "unique-insert" });
  });

  it("carries a guard established inside a helper back to the caller", () => {
    const body = `  await markProcessed(event.id);\n${EFFECT}\n}\nasync function markProcessed(id: string) {\n  await prisma.processedEvent.create({ data: { id } });`;
    expect(unguarded(run(body))).toEqual([]);
  });

  it("scopes a guard inside one branch to that branch", () => {
    const body = `  if (event.type === "a") {\n    if (!(await redis.set(event.id, "1", "NX"))) return new Response("dup");\n  }\n${EFFECT}`;
    expect(unguarded(run(body))).toEqual(["unguarded-side-effect"]);
  });

  it("respects configured guard wrappers", () => {
    const body = `  await withIdempotency(event.id, async () => {\n  ${EFFECT}\n  });\n}\ndeclare function withIdempotency(k: string, fn: () => Promise<void>): Promise<void>;\nfunction _unused() {`;
    expect(unguarded(run(body))).toEqual(["unguarded-side-effect"]);
    expect(unguarded(run(body, { guards: [{ callee: "withIdempotency", atomic: true }] }))).toEqual([]);
  });

  it("classifies increments as non-idempotent and fixed updates as idempotent", () => {
    const inc = `  await prisma.wallet.update({ where: { id: 1 }, data: { balance: { increment: 5 } } });`;
    const set = `  await prisma.wallet.update({ where: { id: 1 }, data: { status: "paid" } });`;
    expect(rules(run(inc))).toEqual(["unguarded-side-effect"]);
    expect(rules(run(set))).toEqual([]);
  });
});

describe("ordering and key rules", () => {
  const SEND_KEYED = (key: string) => `  await stripe.paymentIntents.create({ amount: 1 }, { idempotencyKey: ${key} });`;

  it("record-before-effect-no-tx: claim outside the transaction of later work", () => {
    const body = `  await prisma.processedEvent.create({ data: { id: event.id } });\n  await prisma.order.create({ data: {} });`;
    expect(rules(run(body))).toEqual(["record-before-effect-no-tx"]);
  });

  it("record-before-effect-no-tx clears when claim and work share a transaction (mutation)", () => {
    const body = `  await prisma.$transaction(async (tx) => {\n    await tx.processedEvent.create({ data: { id: event.id } });\n    await tx.order.create({ data: {} });\n  });`;
    expect(rules(run(body))).toEqual([]);
  });

  it("record-before-effect-no-tx drops to low confidence when the claim is released on failure", () => {
    const body = `  if (!(await redis.set(event.id, "1", "NX"))) return new Response("dup");\n  try {\n  ${EFFECT}\n  } catch (e) {\n    await redis.del(event.id);\n    throw e;\n  }`;
    expect(rules(run(body))).toEqual([]);
    expect(rules(run(body, { minConfidence: "low" }))).toEqual(["record-before-effect-no-tx"]);
  });

  it("effect-before-record: lookup, work, then record", () => {
    const body = `  if (await prisma.processedEvent.findUnique({ where: { id: event.id } })) return new Response("dup");\n${EFFECT}\n  await prisma.processedEvent.create({ data: { id: event.id } });`;
    expect(rules(run(body))).toEqual(["effect-before-record"]);
  });

  it("effect-before-record also sees a Redis GET check with a later SET marker", () => {
    const body = `  if (await redis.get(event.id)) return new Response("dup");\n${EFFECT}\n  await redis.set(event.id, "1");`;
    expect(rules(run(body))).toEqual(["effect-before-record"]);
  });

  it("nondeterministic-key: Date.now() and uuid() keys, but not event ids", () => {
    expect(rules(run(SEND_KEYED("`charge-${Date.now()}`")))).toEqual(["nondeterministic-key"]);
    expect(rules(run(`  const key = "charge-" + v4();\n${SEND_KEYED("key")}`))).toEqual(["nondeterministic-key"]);
    expect(rules(run(SEND_KEYED("`charge-${event.id}`")))).toEqual([]);
  });

  it("nondeterministic-key: a dedupe key from randomUUID, ignoring timestamp columns", () => {
    const bad = `  const ok = await redis.set(\`evt:\${crypto.randomUUID()}\`, "1", "NX");\n  if (!ok) return new Response("dup");`;
    expect(rules(run(bad))).toEqual(["nondeterministic-key"]);
    const timestamps = `  await prisma.processedEvent.create({ data: { id: event.id, createdAt: new Date() } });`;
    expect(rules(run(timestamps))).toEqual([]);
  });

  it("effect-missing-idempotency-key: guarded payment without a key", () => {
    const body = `  if (!(await redis.set(event.id, "1", "NX"))) return new Response("dup");\n  await stripe.charges.create({ amount: 1 });`;
    expect(rules(run(body)).sort()).toEqual(["effect-missing-idempotency-key", "record-before-effect-no-tx"]);
  });
});
