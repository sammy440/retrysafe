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
    expect(rules(run(inc))).toEqual(["incrementing-write-unguarded"]);
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
    expect(rules(run(body)).sort()).toEqual(["check-then-insert-race", "effect-before-record"]);
  });

  it("effect-before-record also sees a Redis GET check with a later SET marker", () => {
    const body = `  if (await redis.get(event.id)) return new Response("dup");\n${EFFECT}\n  await redis.set(event.id, "1");`;
    expect(rules(run(body)).sort()).toEqual(["check-then-insert-race", "effect-before-record"]);
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

describe("control flow: try/catch, switch, middleware", () => {
  it("a claim in try whose catch always exits covers the code after the try", () => {
    const body = `  try {\n    await prisma.processedEvent.create({ data: { id: event.id } });\n  } catch (e: any) {\n    if (e.code === "P2002") return new Response("dup");\n    throw e;\n  }\n${EFFECT}`;
    expect(unguarded(run(body))).toEqual([]);
  });

  it("a claim in try whose catch swallows the error does not cover the code after it", () => {
    const body = `  try {\n    await prisma.processedEvent.create({ data: { id: event.id } });\n  } catch (e) {\n    console.log("duplicate?", e);\n  }\n${EFFECT}`;
    expect(unguarded(run(body))).toEqual(["unguarded-side-effect"]);
  });

  it("a guard in one switch case does not cover another case", () => {
    const body = `  switch (event.type) {\n    case "a":\n      if (!(await redis.set(event.id, "1", "NX"))) return new Response("dup");\n      break;\n    case "b":\n    ${EFFECT}\n      break;\n  }`;
    expect(unguarded(run(body))).toEqual(["unguarded-side-effect"]);
  });
});

describe("middleware guards", () => {
  function app(src: string) {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
    for (const [file, s] of Object.entries(LIBS)) project.createSourceFile(file, s);
    project.createSourceFile("/server.ts", `import express from "express";\nimport { redis } from "./lib/redis";\nimport { send } from "./lib/mail";\nconst app = express();\n${src}`);
    return analyze({ project, root: "/", guards: [{ callee: "idempotent", atomic: true }] });
  }
  const dedupe = `async function dedupe(req: any, res: any, next: any) {\n  if (!(await redis.set(req.body.id, "1", "NX"))) return res.sendStatus(200);\n  next();\n}`;
  const route = `app.post("/webhooks/x", async (req, res) => { await send(req.body.email); res.sendStatus(200); });`;

  it("route-level middleware that claims the event guards the handler", () => {
    expect(unguarded(app(`${dedupe}\napp.post("/webhooks/x", dedupe, async (req, res) => { await send(req.body.email); res.sendStatus(200); });`))).toEqual([]);
  });
  it("app.use middleware registered before the route guards it; after the route it does not", () => {
    expect(unguarded(app(`${dedupe}\napp.use(dedupe);\n${route}`))).toEqual([]);
    expect(unguarded(app(`${dedupe}\n${route}\napp.use(dedupe);`))).toEqual(["unguarded-side-effect"]);
  });
  it("configured guard middleware factories are trusted", () => {
    expect(unguarded(app(`declare function idempotent(): any;\napp.post("/webhooks/x", idempotent(), async (req, res) => { await send(req.body.email); res.sendStatus(200); });`))).toEqual([]);
  });
});

describe("probot", () => {
  it("discovers app.on handlers and classifies context.octokit calls", () => {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
    project.createSourceFile(
      "/index.ts",
      `import { Probot } from "probot";\nexport default (app: Probot) => {\n  app.on("issues.opened", async (context) => {\n    await context.octokit.issues.createComment(context.issue({ body: "Thanks!" }));\n  });\n};`,
    );
    const r = analyze({ project, root: "/" });
    expect(r.handlers.map((h) => h.handler.name)).toEqual(["Probot on issues.opened"]);
    expect(rules(r)).toEqual(["unguarded-side-effect"]);
  });
});

describe("low-confidence heuristics", () => {
  it("order-dependence-assumed: state set from several event types without a timestamp check", () => {
    const body = `  switch (event.type) {\n    case "subscription.updated":\n      await prisma.subscription.update({ where: { id: event.data.id }, data: { status: "active" } });\n      break;\n    case "subscription.deleted":\n      await prisma.subscription.update({ where: { id: event.data.id }, data: { status: "canceled" } });\n      break;\n  }`;
    expect(rules(run(body))).toEqual([]);
    expect(rules(run(body, { minConfidence: "low" }))).toEqual(["order-dependence-assumed"]);
    const guarded = body.replace(/where: \{ id: event.data.id \}/g, "where: { id: event.data.id, updatedAt: { lt: new Date(event.created * 1000) } }");
    expect(rules(run(guarded, { minConfidence: "low" }))).toEqual([]);
  });

  it("wrong-event-field-as-key: data.id keys are only a weak signal (Paystack/Flutterwave have no event id)", () => {
    const body = `  await prisma.$transaction(async (tx) => {\n    await tx.processedEvent.create({ data: { id: event.data.id } });\n  });`;
    expect(rules(run(body))).toEqual([]);
    expect(rules(run(body, { minConfidence: "low" }))).toEqual(["wrong-event-field-as-key"]);
    const typed = body.replace("event.data.id", "`${event.type}:${event.data.id}`");
    expect(rules(run(typed, { minConfidence: "low" }))).toEqual([]);
  });

  it("unresolved calls with effect-like names surface only at low confidence", () => {
    const body = `}\nexport async function PUT(req: Request, deps: any) {\n  await deps.billing.chargeCustomer("c");`;
    expect(rules(run(body))).toEqual([]);
    expect(rules(run(body, { minConfidence: "low" }))).toEqual(["unguarded-side-effect"]);
  });

  it("does not treat reading the delivery (req.text(), res.send(), job.updateProgress()) as unknown effects", () => {
    const body = `  const raw = await req.text();\n}\nexport async function PATCH(request: Request, job: any) {\n  await request.text();\n  await job.updateProgress(50);`;
    const r = run(body, { minConfidence: "low" });
    expect(r.handlers.flatMap((h) => h.effects).filter((e) => e.kind === "unknown")).toEqual([]);
  });
});
