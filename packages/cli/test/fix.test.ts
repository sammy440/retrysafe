import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyze } from "@retrysafe/core";
import { runFix, type FixOptions } from "../src/fix/index";

const FIXTURES = path.resolve(__dirname, "../../../fixtures");
const dirs: string[] = [];

function copy(fixture: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "retrysafe-fix-"));
  cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

function fixAndWrite(opts: FixOptions) {
  const r = runFix(opts);
  for (const [file, text] of r.changes) writeFileSync(file, text);
  return r;
}

const ids = (root: string) => analyze({ root }).findings.map((f) => `${f.rule} ${f.location.file}`);

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("retrysafe fix", () => {
  it("adds jobId and idempotency keys derived from the job id", () => {
    const root = copy("bullmq-worker");
    const r = fixAndWrite({ root });
    expect(r.applied.map((a) => a.rule).sort()).toEqual(["effect-missing-idempotency-key", "queue-add-without-job-id"]);
    const src = readFileSync(path.join(root, "src/worker.ts"), "utf8");
    expect(src).toContain('await emailQueue.add("followup", { email: job.data.email }, { jobId: `emailQueue.add:${job.id}` });');
    expect(src).toContain("idempotencyKey: `transfers.create:${job.id}`");
    const after = ids(root);
    expect(after).not.toContain("queue-add-without-job-id src/worker.ts");
    expect(after).not.toContain("effect-missing-idempotency-key src/worker.ts");
  });

  it("answers permanent failures with 400 instead of 5xx", () => {
    const root = copy("rules-phase8");
    const r = fixAndWrite({ root, onlyRules: ["permanent-error-returns-5xx"] });
    expect(r.applied).toHaveLength(2);
    const src = readFileSync(path.join(root, "src/app.ts"), "utf8");
    expect(src).toContain('return res.status(400).send("bad signature"); // expect: permanent-error-returns-5xx');
    expect(src).toContain("res.status(400).json({ error: \"missing customer\" })");
    expect(ids(root).filter((x) => x.startsWith("permanent-error"))).toEqual([]);
  });

  it("wraps a handler with a transactional guard and routes its Prisma writes through tx", () => {
    const root = copy("express-basic");
    writeFileSync(
      path.join(root, "src/lib/guard.ts"),
      `import { prismaGuard } from "@retrysafe/guard";\nimport { prisma } from "./db";\nexport const guard = prismaGuard(prisma);\n`,
    );
    const before = ids(root);
    expect(before).toContain("unguarded-side-effect src/app.ts");
    const r = fixAndWrite({ root, guard: "./src/lib/guard#guard", onlyRules: ["unguarded-side-effect"] });
    expect(r.applied.map((a) => a.description)).toContain("wrap the handler's work in guard.run(eventKey.stripe(event), ...)");

    const src = readFileSync(path.join(root, "src/app.ts"), "utf8");
    expect(src).toContain('import { eventKey } from "@retrysafe/guard";');
    expect(src).toContain('import { guard } from "./lib/guard";');
    expect(src).toContain("const result = await guard.run(eventKey.stripe(event), async (tx) => {");
    expect(src).toContain("await tx.order.create(");
    expect(src).toContain('if (result.status === "duplicate") return res.status(200).end();');

    // The Stripe handler's own write and the receipt email it sends through a helper are now guarded.
    const after = analyze({ root }).findings.filter((f) => f.handler.includes("POST /webhooks/stripe"));
    expect(after.map((f) => f.rule)).toEqual([]);
  });

  it("explains what it cannot fix", () => {
    const root = copy("express-basic");
    const r = runFix({ root, onlyRules: ["unguarded-side-effect"] });
    const reasons = r.skipped.map((s) => `${s.file}: ${s.reason}`);
    expect(reasons.some((x) => x.includes("pass --guard"))).toBe(true);
    expect(reasons.some((x) => x.includes("is in a helper"))).toBe(true);
    expect(r.changes.size).toBe(0);
  });
});
