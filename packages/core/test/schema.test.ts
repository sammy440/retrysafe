import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { analyze } from "../src";
import { insertProtection, parsePrismaSchema, parseSqlSchema, type SchemaFacts } from "../src/schema";

const HANDLER = `import { PrismaClient } from "@prisma/client";
import nodemailer from "nodemailer";
const prisma = new PrismaClient();
const t = nodemailer.createTransport({});
export async function POST(req: Request) {
  const event: any = await req.json();
  await prisma.$transaction(async (tx) => {
    await tx.processedEvent.create({ data: { eventId: event.id } });
    await tx.order.create({ data: { id: event.data.id } });
  });
  return new Response("ok");
}`;

function run(files: Record<string, string>) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const fs = project.getFileSystem();
  for (const [f, src] of Object.entries(files)) {
    if (/\.(prisma|sql|json)$/.test(f)) fs.writeFileSync(f, src);
    else project.createSourceFile(f, src);
  }
  return analyze({ project, root: "/" });
}
const rules = (r: ReturnType<typeof run>) => r.findings.map((f) => f.rule).sort();

describe("schema awareness: a processed-events insert is a claim only with a unique constraint", () => {
  const route = { "/app/api/webhooks/x/route.ts": HANDLER };

  it("unknown schema: trusted, marked atomic-if-unique", () => {
    const r = run(route);
    expect(rules(r)).toEqual([]);
    expect(r.handlers[0]!.guards[0]).toMatchObject({ kind: "unique-insert", atomic: "unknown", schema: "not-found" });
  });

  it("Prisma: @unique on the inserted field makes it atomic; without it the order write is unguarded", () => {
    const unique = run({ ...route, "/prisma/schema.prisma": `model ProcessedEvent {\n  id Int @id @default(autoincrement())\n  eventId String @unique\n}` });
    expect(rules(unique)).toEqual([]);
    expect(unique.handlers[0]!.guards[0]).toMatchObject({ atomic: true, schema: "unique-constraint", schemaSource: "prisma/schema.prisma" });

    const plain = run({ ...route, "/prisma/schema.prisma": `model ProcessedEvent {\n  id Int @id @default(autoincrement())\n  eventId String\n}` });
    expect(rules(plain)).toEqual(["unguarded-side-effect"]);
    expect(plain.findings[0]!.message).toMatch(/no unique constraint in prisma\/schema\.prisma/);
  });

  it("SQL migrations: a unique index created later counts", () => {
    const create = `CREATE TABLE "ProcessedEvent" ("id" SERIAL PRIMARY KEY, "eventId" TEXT NOT NULL);`;
    expect(rules(run({ ...route, "/prisma/migrations/1_init/migration.sql": create }))).toEqual(["unguarded-side-effect"]);
    const withIndex = `${create}\nCREATE UNIQUE INDEX "ProcessedEvent_eventId_key" ON "ProcessedEvent"("eventId");`;
    expect(rules(run({ ...route, "/prisma/migrations/1_init/migration.sql": withIndex }))).toEqual([]);
  });

  it("Drizzle tables declared in TypeScript", () => {
    const handler = `import { drizzle } from "drizzle-orm/node-postgres";
import { processedEvents, orders } from "./schema";
const db = drizzle("url");
export async function POST(req: Request) {
  const e: any = await req.json();
  await db.insert(processedEvents).values({ eventId: e.id });
  await db.insert(orders).values({ id: e.id });
  return new Response();
}`;
    const schema = (col: string) => `import { pgTable, text, serial } from "drizzle-orm/pg-core";
export const processedEvents = pgTable("processed_events", { id: serial("id").primaryKey(), eventId: ${col} });
export const orders = pgTable("orders", { id: text("id") });`;
    const ok = run({ "/app/api/webhooks/x/route.ts": handler, "/app/api/webhooks/x/schema.ts": schema(`text("event_id").unique()`) });
    expect(ok.handlers[0]!.guards[0]).toMatchObject({ atomic: true });
    const bad = run({ "/app/api/webhooks/x/route.ts": handler, "/app/api/webhooks/x/schema.ts": schema(`text("event_id")`) });
    expect(rules(bad)).toEqual(["unguarded-side-effect"]);
  });

  it("Mongoose: _id is always unique", () => {
    const r = run({
      "/models.ts": `import mongoose from "mongoose";\nconst s = new mongoose.Schema({ _id: String });\nexport const ProcessedEvent = mongoose.model("ProcessedEvent", s);`,
      "/app/api/webhooks/x/route.ts": `import { ProcessedEvent } from "../../../../models";\nexport async function POST(req: Request) {\n  const e: any = await req.json();\n  await ProcessedEvent.create({ _id: e.id });\n  return new Response();\n}`,
    });
    expect(r.handlers[0]!.guards[0]).toMatchObject({ atomic: true, schema: "unique-constraint" });
  });
});

describe("schema parsers", () => {
  it("Prisma: @@unique, @@id, @@map, composite keys", () => {
    const facts: SchemaFacts = { tables: new Map() };
    parsePrismaSchema(`model WebhookEvent {\n  provider String\n  eventId  String\n  // comment @unique\n  @@unique([provider, eventId])\n  @@map("webhook_events")\n}`, facts, "s");
    expect(insertProtection(facts, "webhookEvent", ["provider", "eventId"])).toBe("unique-constraint");
    expect(insertProtection(facts, "webhook_events", ["eventId"])).toBe("no-unique-constraint");
  });

  it("SQL: inline, table-level, ALTER TABLE, and IF NOT EXISTS forms", () => {
    const facts: SchemaFacts = { tables: new Map() };
    parseSqlSchema(
      `-- events
       CREATE TABLE IF NOT EXISTS processed_events (event_id text NOT NULL, created_at timestamptz, CONSTRAINT pk PRIMARY KEY (event_id));
       CREATE TABLE inbox (id text, source text);
       ALTER TABLE ONLY inbox ADD CONSTRAINT inbox_uniq UNIQUE (source, id);`,
      facts,
      "m.sql",
    );
    expect(insertProtection(facts, "processed_events", ["event_id", "created_at"])).toBe("unique-constraint");
    expect(insertProtection(facts, "inbox", ["id", "source"])).toBe("unique-constraint");
    expect(insertProtection(facts, "inbox", ["id"])).toBe("no-unique-constraint");
  });
});
