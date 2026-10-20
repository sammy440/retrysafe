import { createHmac } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyze } from "@retrysafe/core";
import { runVerify, type VerifyReport } from "../src/verify/index";

const FIXTURES = path.resolve(__dirname, "../../../fixtures");

const PAYLOAD = {
  id: "evt_test_1",
  type: "test.event",
  data: { id: "obj_1", amount: 1000, customer: { id: "cus_1" }, metadata: { userId: "u1" }, object: { id: "obj_1", customer_email: "a@b.c" } },
};

async function verify(
  fixture: string,
  handler: string,
  extra: { env?: Record<string, string>; headers?: (payload: unknown) => Record<string, string> } = {},
): Promise<VerifyReport> {
  const root = path.join(FIXTURES, fixture);
  const result = analyze({ root });
  const report = result.handlers.find((h) => h.handler.name === handler);
  if (!report) throw new Error(`no handler ${handler}`);
  // Like the CLI: deliver the first event type the handler branches on.
  const payload = { ...PAYLOAD, type: report.eventTypes[0] ?? PAYLOAD.type };
  return runVerify({ root, result, report, payload, headers: extra.headers?.(payload) ?? {}, env: extra.env });
}

const scenario = (r: VerifyReport, name: string) => r.scenarios.find((s) => s.name.startsWith(name))!;
const confirmedRules = (r: VerifyReport) => r.confirmed.map((c) => `${c.finding.rule} ${c.finding.location.file}:${c.finding.location.line}`).sort();

describe("retrysafe verify (dynamic)", () => {
  it("reproduces unguarded duplicates on retry and confirms the static findings", async () => {
    const r = await verify("express-basic", "POST /webhooks/stripe");
    expect(scenario(r, "retry after success").repeated.map((s) => s.key).sort()).toEqual(["src/app.ts:17", "src/lib/mail.ts:6"]);
    expect(confirmedRules(r)).toEqual(["unguarded-side-effect src/app.ts:17", "unguarded-side-effect src/lib/mail.ts:6"]);
    expect(r.unconfirmed).toEqual([]);
  }, 60_000);

  it("finds nothing for a transactional claim, in any scenario", async () => {
    const r = await verify("express-basic", "POST /webhooks/flutterwave");
    for (const s of r.scenarios) expect({ name: s.name, repeated: s.repeated, lost: s.lost }).toEqual({ name: s.name, repeated: [], lost: [] });
  }, 60_000);

  it("shows a record-first handler losing the event when it crashes after the claim", async () => {
    const r = await verify("express-basic", "POST /webhooks/paystack", {
      env: { PAYSTACK_SECRET: "sk_test" },
      headers: (payload) => ({ "x-paystack-signature": createHmac("sha512", "sk_test").update(JSON.stringify(payload)).digest("hex") }),
    });
    expect(scenario(r, "crash before effect 1").lost.map((s) => s.key)).toEqual(["src/app.ts:38"]);
    expect(confirmedRules(r)).toEqual(["record-before-effect-no-tx src/app.ts:35"]);
  }, 60_000);

  it("reproduces a lookup-then-insert race with concurrent deliveries", async () => {
    const r = await verify("express-basic", "POST /billing/callback");
    expect(scenario(r, "retry after success").repeated).toEqual([]);
    expect(scenario(r, "concurrent duplicate").repeated.map((s) => s.key)).toEqual(["src/lib/mail.ts:6"]);
    expect(confirmedRules(r)).toContain("check-then-insert-race src/routes/billing.ts:15");
  }, 60_000);

  it("drives queue workers, Next.js routes, and Lambda handlers", async () => {
    expect(scenario(await verify("bullmq-worker", 'Worker queue "invoices"'), "retry").repeated.map((s) => s.key)).toEqual(["src/worker.ts:17"]);
    expect(scenario(await verify("next-app", "POST /api/webhooks/stripe"), "retry").repeated.length).toBe(2);
    expect(scenario(await verify("serverless", "Lambda src/orders.ts#handler (SQS)"), "concurrent").repeated.map((s) => s.key)).toEqual(["src/orders.ts:13"]);
  }, 120_000);
});
