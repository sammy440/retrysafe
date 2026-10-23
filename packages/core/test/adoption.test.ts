import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { analyze, applyBaseline, createBaseline, parseConfig, ConfigError, type AnalyzeOptions } from "../src";

const ROUTE = "/app/api/webhooks/test/route.ts";

function project(files: Record<string, string>) {
  const p = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  p.createSourceFile("/lib/mail.ts", `import nodemailer from "nodemailer";\nconst t = nodemailer.createTransport({});\nexport const send = (to: string) => t.sendMail({ to });`);
  for (const [f, src] of Object.entries(files)) p.createSourceFile(f, src);
  return p;
}

const route = (body: string) => `import { send } from "../../../../lib/mail";
export async function POST(req: Request) {
  const event: any = await req.json();
${body}
  return new Response("ok");
}`;

const run = (files: Record<string, string>, opts: AnalyzeOptions = {}) => analyze({ project: project(files), root: "/", ...opts });

describe("inline suppressions", () => {
  it("honors a suppression with a reason, on the line or the line above", () => {
    const same = run({ [ROUTE]: route(`  await send(event.email);`) });
    expect(same.findings).toHaveLength(1);
    const suppressedMail = project({ [ROUTE]: route(`  await send(event.email);`) });
    suppressedMail
      .getSourceFileOrThrow("/lib/mail.ts")
      .replaceWithText(
        `import nodemailer from "nodemailer";\nconst t = nodemailer.createTransport({});\n// retrysafe-ignore-next-line unguarded-side-effect -- the ESP dedupes on Message-ID\nexport const send = (to: string) => t.sendMail({ to });`,
      );
    const r = analyze({ project: suppressedMail, root: "/" });
    expect(r.findings).toHaveLength(0);
    expect(r.suppressed).toMatchObject([{ by: "inline", reason: "the ESP dedupes on Message-ID" }]);
  });

  it("does not honor a suppression without a reason", () => {
    const p = project({ [ROUTE]: route(`  await send(event.email);`) });
    p.getSourceFileOrThrow("/lib/mail.ts").replaceWithText(
      `import nodemailer from "nodemailer";\nconst t = nodemailer.createTransport({});\nexport const send = (to: string) => t.sendMail({ to }); // retrysafe-ignore unguarded-side-effect`,
    );
    const r = analyze({ project: p, root: "/" });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.suppressionError).toMatch(/needs a reason/);
  });
});

describe("baseline and fingerprints", () => {
  it("fingerprints survive line shifts but change when the flagged line changes", () => {
    const a = run({ [ROUTE]: route(`  await send(event.email);`) });
    const shifted = run({ [ROUTE]: `// a new comment\n// and another\n${route(`  await send(event.email);`)}` });
    expect(shifted.findings[0]!.id).toBe(a.findings[0]!.id);
  });

  it("moves baselined findings out of the active list, and reports new ones", () => {
    const before = run({ [ROUTE]: route(`  await send(event.email);`) });
    const baseline = createBaseline(before.findings, (id) => id);
    const after = run({
      [ROUTE]: route(`  await send(event.email);`),
      "/lib/sms.ts": `import twilio from "twilio";\nconst c = twilio("a", "b");\nexport const text = () => c.messages.create({});`,
      "/app/api/webhooks/other/route.ts": `import { text } from "../../../../lib/sms";\nexport async function POST() { await text(); return new Response(); }`,
    });
    const applied = applyBaseline(after, baseline);
    expect(applied.findings.map((f) => f.location.file)).toEqual(["lib/sms.ts"]);
    expect(applied.suppressed.map((s) => s.by)).toEqual(["baseline"]);
  });
});

describe("config-driven analysis", () => {
  it("handlers.add marks a function as at-least-once; handlers.ignore skips by name or file", () => {
    const files = {
      "/src/jobs/invoice.ts": `import { send } from "../../lib/mail";\nexport async function handler(evt: any) { await send(evt.to); }`,
      [ROUTE]: route(`  await send(event.email);`),
    };
    const r = run(files, { handlers: { add: ["src/jobs/invoice.ts#handler"], ignore: ["app/api/webhooks/**"] } });
    expect(r.handlers.map((h) => h.handler.name)).toEqual(["src/jobs/invoice.ts#handler"]);
    expect(run(files, { handlers: { ignore: ["POST /api/webhooks/test"] } }).handlers).toHaveLength(0);
  });

  it("exclude keeps test files out of discovery by default", () => {
    const r = run({ "/app/api/webhooks/test/route.test.ts": route(`  await send(event.email);`) });
    expect(r.handlers).toHaveLength(0);
  });

  it("effects.extend can declare a project wrapper as an effect", () => {
    const files = {
      "/lib/billing.ts": `export async function chargeCustomer(id: string) { /* calls an internal service */ }`,
      [ROUTE]: `import { chargeCustomer } from "../../../../lib/billing";\nexport async function POST(req: Request) { await chargeCustomer("c"); return new Response(); }`,
    };
    expect(run(files).findings).toHaveLength(0);
    const r = run(files, { effects: [{ match: { module: "lib/billing", callee: "chargeCustomer" }, kind: "payment", idempotent: false }] });
    expect(r.findings.map((f) => f.rule)).toEqual(["unguarded-side-effect"]);
  });

  it("rejects invalid config and unknown rule ids with readable messages", () => {
    expect(() => parseConfig({ rules: { "unguraded-side-effect": "off" } }, "cfg", ["unguarded-side-effect"])).toThrow(/unknown rule/);
    expect(() => parseConfig({ analysis: { maxCallDepth: -1 } })).toThrow(ConfigError);
    expect(parseConfig({ handlers: { add: ["a.ts#h"] } })).toEqual({ handlers: { add: ["a.ts#h"] } });
  });
});

describe("server actions (opt-in)", () => {
  const files = {
    "/app/actions.ts": `"use server";\nimport { send } from "../lib/mail";\nexport async function subscribe(email: string) { await send(email); }`,
    "/app/inline.tsx": `import { send } from "../lib/mail";\nexport default function Page() {\n  async function notify() {\n    "use server";\n    await send("x");\n  }\n  return notify;\n}`,
  };
  it("are ignored by default and discovered with handlers.serverActions", () => {
    expect(run(files).handlers).toHaveLength(0);
    const names = run(files, { handlers: { serverActions: true } }).handlers.map((h) => h.handler.name).sort();
    expect(names).toEqual(["Server action app/actions.ts#subscribe", "Server action app/inline.tsx#notify"]);
  });
});
