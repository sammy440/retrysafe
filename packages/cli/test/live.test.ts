import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startLiveServer, type LiveMessage, type LiveServer } from "../src/live/server";

const FIXTURES = path.resolve(__dirname, "../../../fixtures");
const ORIGIN = "http://localhost:3000";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function start(fixture: string): Promise<{ root: string; server: LiveServer }> {
  const root = mkdtempSync(path.join(tmpdir(), "retrysafe-live-"));
  cpSync(path.join(FIXTURES, fixture), root, { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const server = await startLiveServer({ root, port: 0, origins: [ORIGIN], debounceMs: 50 });
  cleanups.push(() => server.close());
  return { root, server };
}

/** Connects like the browser does and collects messages. */
function connect(server: LiveServer, opts: { token?: string; origin?: string } = {}) {
  const messages: LiveMessage[] = [];
  const waiters: { pred: (m: LiveMessage) => boolean; resolve: (m: LiveMessage) => void }[] = [];
  const ws = new WebSocket(`${server.url}?token=${opts.token ?? server.token}`, { origin: opts.origin ?? ORIGIN });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString()) as LiveMessage;
    messages.push(m);
    for (const w of [...waiters]) {
      if (!w.pred(m)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  cleanups.push(() => ws.close());
  const next = (pred: (m: LiveMessage) => boolean, ms = 15_000) =>
    new Promise<LiveMessage>((resolve, reject) => {
      const found = messages.find(pred);
      if (found) return resolve(found);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error("timed out waiting for message")), ms);
    });
  return { ws, messages, next };
}

const findingsOf = (m: LiveMessage) => (m.type === "result" ? m.result.findings.map((f) => `${f.rule} ${f.location.file}:${f.location.line}`) : []);

describe("retrysafe live", () => {
  it("sends the current analysis on connect, then re-analyzes when a file is saved", async () => {
    const { root, server } = await start("express-basic");
    const c = connect(server);
    const hello = await c.next((m) => m.type === "hello");
    expect(hello).toMatchObject({ type: "hello", name: path.basename(root) });
    const first = await c.next((m) => m.type === "result");
    expect(findingsOf(first)).toContain("unguarded-side-effect src/routes/billing.ts:38");
    const f = first.type === "result" ? first.result.findings.find((x) => x.location.file === "src/routes/billing.ts" && x.location.line === 38) : undefined;
    expect(f?.excerpt?.lines.some((l) => l.includes("paymentIntents.create"))).toBe(true);

    // The user adds an idempotency key in their editor and saves.
    const file = path.join(root, "src/routes/billing.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace('currency: "usd", confirm: true });', 'currency: "usd", confirm: true }, { idempotencyKey: `topup:${customer}` });'));

    await c.next((m) => m.type === "analyzing" && m.changedFiles.includes("src/routes/billing.ts"));
    const second = await c.next((m) => m.type === "result" && m !== first);
    expect(findingsOf(second)).not.toContain("unguarded-side-effect src/routes/billing.ts:38");
    expect(second.type === "result" && second.changedFiles).toEqual(["src/routes/billing.ts"]);
  }, 60_000);

  it("picks up new files", async () => {
    const { root, server } = await start("express-basic");
    const c = connect(server);
    await c.next((m) => m.type === "result");
    writeFileSync(
      path.join(root, "src/routes/refunds.ts"),
      `import { Router } from "express";\nimport { prisma } from "../lib/db";\nexport const refunds = Router();\nrefunds.post("/webhooks/refunds", async (req, res) => {\n  await prisma.refund.create({ data: { id: req.body.id } });\n  res.sendStatus(200);\n});\n`,
    );
    const r = await c.next((m) => m.type === "result" && findingsOf(m).some((x) => x.startsWith("unguarded-side-effect src/routes/refunds.ts")));
    expect(r.type).toBe("result");
  }, 60_000);

  it("rejects connections without the token or from other sites", async () => {
    const { server } = await start("bullmq-worker");
    const refused = (opts: { token?: string; origin?: string }) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`${server.url}?token=${opts.token ?? server.token}`, { origin: opts.origin ?? ORIGIN });
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("open", () => resolve(101));
      });
    expect(await refused({ token: "wrong" })).toBe(403);
    expect(await refused({ origin: "https://evil.example" })).toBe(403);
    expect(await refused({})).toBe(101);
  }, 30_000);
});
