import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { PACKS, loadProjects, type AnalysisResult, type Finding, type HandlerReport } from "@retrysafe/core";
import { deliver, type Delivery, type DeliveryResult } from "./drivers";
import { SimulatedCrash, VerifyRuntime, type CallRecord } from "./runtime";
import { stubFor } from "./stubs";

/** Libraries replaced by recording stubs: every catalog pack plus frameworks, verifiers, and id generators. */
const FRAMEWORKS = [
  "express", "fastify", "next/server", "next/headers", "bullmq", "bull", "sqs-consumer", "probot", "mongoose", "knex",
  "drizzle-orm", "drizzle-orm/node-postgres", "drizzle-orm/postgres-js", "drizzle-orm/neon-http", "drizzle-orm/neon-serverless",
  "drizzle-orm/mysql2", "drizzle-orm/better-sqlite3", "drizzle-orm/libsql", "drizzle-orm/vercel-postgres", "drizzle-orm/pg-core",
  "drizzle-orm/mysql-core", "drizzle-orm/sqlite-core", "postgres", "svix", "standardwebhooks", "@octokit/webhooks", "@shopify/shopify-api",
  "@aws-sdk/client-sqs", "@aws-sdk/client-sns", "@aws-sdk/client-ses", "@aws-sdk/client-sesv2", "@aws-sdk/client-eventbridge",
  "@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb", "@aws-sdk/client-lambda", "@aws-sdk/client-s3", "@aws-sdk/client-sfn",
  "@aws-sdk/client-kinesis", "uuid", "nanoid", "cuid", "@paralleldrive/cuid2", "ulid",
];

export function stubbedModules(extra: string[] = []): string[] {
  const fromPacks = PACKS.flatMap((p) => p.effects.flatMap((e) => [e.match.module].flat())).filter((m) => !m.startsWith("global:"));
  return [...new Set([...fromPacks, ...FRAMEWORKS, ...extra])];
}

export interface VerifyOptions {
  root: string;
  /** Static analysis of the project, already filtered/configured. */
  result: AnalysisResult;
  report: HandlerReport;
  payload: unknown;
  headers: Record<string, string>;
  concurrent?: boolean;
  crashSweep?: boolean;
  extraStubs?: string[];
  /** Environment variables for the run; unset variables read as placeholder strings. */
  env?: Record<string, string>;
}

export interface Scenario {
  name: string;
  deliveries: DeliveryResult[];
  /** Effect sites performed by delivery 1 and again by delivery 2. */
  repeated: Site[];
  /** Effect sites performed by the clean run but by neither delivery of this scenario. */
  lost: Site[];
  deduped: Site[];
}

export interface Site {
  key: string;
  module: string;
  call: string;
  file?: string;
  line?: number;
}

export interface VerifyReport {
  handler: string;
  scenarios: Scenario[];
  confirmed: { finding: Finding; scenario: string; how: "repeated" | "lost" }[];
  unconfirmed: Finding[];
  notes: string[];
}

const siteOf = (c: CallRecord): Site => ({
  key: c.file ? `${c.file}:${c.line}` : `${c.module}:${c.chain.join(".")}`,
  module: c.module,
  call: c.chain.join("."),
  file: c.file,
  line: c.line,
});

function performed(calls: CallRecord[], run: number): Map<string, Site> {
  const out = new Map<string, Site>();
  for (const c of calls) if (c.run === run && c.effect && !c.deduped && !c.rolledBack) out.set(siteOf(c).key, siteOf(c));
  return out;
}

/** TypeScript `paths` as jiti aliases: "@/*" -> "<baseUrl>/*" becomes "@" -> "<dir>". */
function pathAliases(root: string): Record<string, string> {
  const alias: Record<string, string> = {};
  for (const loaded of loadProjects(root)) {
    const opts = loaded.project.getCompilerOptions();
    const base = (opts.baseUrl as string | undefined) ?? (opts.pathsBasePath as string | undefined) ?? root;
    for (const [pattern, targets] of Object.entries((opts.paths as Record<string, string[]>) ?? {})) {
      const target = targets[0];
      if (!target) continue;
      const from = pattern.replace(/\/\*$/, "");
      const to = path.resolve(base, target.replace(/\/\*$/, ""));
      alias[from] = to;
    }
  }
  return alias;
}

/** `process.env.NAME` / `process.env["NAME"]` references in the project. */
function envNames(root: string): Set<string> {
  const out = new Set<string>();
  for (const loaded of loadProjects(root)) {
    for (const sf of loaded.sourceFiles) {
      for (const m of sf.getFullText().matchAll(/process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\])/g)) out.add((m[1] ?? m[2])!);
    }
  }
  return out;
}

/** Names each module is imported by in the project: `import { PrismaClient } from "@prisma/client"`. */
function importedNames(root: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const loaded of loadProjects(root)) {
    for (const sf of loaded.sourceFiles) {
      for (const d of sf.getImportDeclarations()) {
        const set = out.get(d.getModuleSpecifierValue()) ?? new Set<string>();
        for (const n of d.getNamedImports()) set.add(n.getName());
        out.set(d.getModuleSpecifierValue(), set);
      }
    }
  }
  return out;
}

/** Files to import so the handler's routes get registered: its own file, then files that import it. */
function importOrder(root: string, file: string): string[] {
  const abs = path.join(root, file);
  const order = [abs];
  for (const loaded of loadProjects(root)) {
    const sf = loaded.project.getSourceFile(abs);
    if (!sf) continue;
    const queue = [sf];
    const seen = new Set([sf]);
    while (queue.length) {
      for (const ref of queue.shift()!.getReferencingSourceFiles()) {
        if (seen.has(ref) || ref.isInNodeModules()) continue;
        seen.add(ref);
        queue.push(ref);
        order.push(ref.getFilePath());
      }
    }
  }
  return [...new Set(order)];
}

/**
 * Experimental dynamic verification: load the handler with stubbed libraries, deliver the same event
 * twice (sequentially, concurrently, and with a crash injected before each effect), and compare.
 */
export async function runVerify(opts: VerifyOptions): Promise<VerifyReport> {
  const rt = new VerifyRuntime(opts.root);
  const cache = new Map<string, unknown>();
  const stub = (m: string) => {
    if (!cache.has(m)) cache.set(m, stubFor(rt, m));
    return cache.get(m);
  };
  globalThis.__retrysafeVerify = { runtime: rt, stub };

  const dir = mkdtempSync(path.join(tmpdir(), "retrysafe-verify-"));
  writeFileSync(path.join(dir, "package.json"), '{ "type": "commonjs" }\n');
  const alias: Record<string, string> = pathAliases(opts.root);
  const names = importedNames(opts.root);
  for (const m of stubbedModules(opts.extraStubs)) {
    const file = path.join(dir, ...m.split("/"), "index.js");
    mkdirSync(path.dirname(file), { recursive: true });
    // Node loads these natively, so named exports must be statically visible (`module.exports.X =`).
    const named = [...(names.get(m) ?? [])].filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && n !== "default");
    writeFileSync(
      file,
      [
        `const s = globalThis.__retrysafeVerify.stub(${JSON.stringify(m)});`,
        "module.exports = s;",
        "try { module.exports.default = s; } catch {}",
        ...named.map((n) => `try { module.exports.${n} = s.${n}; } catch {}`),
        "",
      ].join("\n"),
    );
    alias[m] = file;
  }

  const realEnv = process.env;
  // Handlers read secrets at import time (new Stripe(process.env.STRIPE_KEY!)); give the ones the project
  // references a placeholder so the code runs, without touching variables tooling depends on.
  const placeholders = Object.fromEntries([...envNames(opts.root)].filter((k) => !(k in realEnv)).map((k) => [k, `retrysafe_${k.toLowerCase()}`]));
  process.env = { ...realEnv, ...placeholders, ...opts.env };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") rt.record("global:fetch", [method.toLowerCase()]);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  process.setSourceMapsEnabled?.(true);
  const notes: string[] = [];

  try {
    const jiti = createJiti(path.join(opts.root, "index.js"), { alias, interopDefault: true, moduleCache: true, fsCache: false, sourceMaps: true });
    const handler = opts.report.handler;
    let mod: Record<string, unknown> = {};
    for (const [i, file] of importOrder(opts.root, handler.location.file).entries()) {
      const loaded = (await jiti.import(file)) as Record<string, unknown>;
      if (i === 0) mod = loaded;
    }

    const delivery: Delivery = { payload: opts.payload, headers: opts.headers };
    const one = (run: number) => rt.delivery.run(run, () => deliver(handler, mod, rt, delivery, run));

    const scenarios: Scenario[] = [];
    const analyze = (name: string, deliveries: DeliveryResult[], clean?: Map<string, Site>): Scenario => {
      const first = performed(rt.calls, 1);
      const second = performed(rt.calls, 2);
      const repeated = [...first.values()].filter((s) => second.has(s.key));
      const lost = clean ? [...clean.values()].filter((s) => !first.has(s.key) && !second.has(s.key)) : [];
      const deduped = rt.calls.filter((c) => c.deduped).map(siteOf);
      return { name, deliveries, repeated, lost, deduped };
    };

    // 1. Retry after a successful delivery.
    rt.reset();
    const seq = [await one(1), await one(2)];
    const clean = performed(rt.calls, 1);
    scenarios.push(analyze("retry after success", seq));
    if (seq[0]?.error && !clean.size) notes.push(`delivery 1 failed before any effect: ${seq[0].error}`);

    // 2. Two copies at once.
    if (opts.concurrent !== false) {
      rt.reset();
      const both = await Promise.all([one(1), one(2)]);
      scenarios.push(analyze("concurrent duplicate", both));
    }

    // 3. Crash before each effect of delivery 1, then retry.
    if (opts.crashSweep !== false) {
      for (let i = 1; i <= clean.size; i++) {
        rt.reset(i);
        const crashed = await one(1);
        rt.crashAt = undefined;
        const retry = await one(2);
        if (crashed.error && !crashed.error.includes(new SimulatedCrash().message)) notes.push(`crash ${i}: unexpected error ${crashed.error}`);
        scenarios.push(analyze(`crash before effect ${i}, then retry`, [crashed, retry], clean));
      }
    }

    // Static findings confirmed by a scenario: the finding's effect (or its call site) repeated or was lost.
    const DUP_RULES = new Set(["unguarded-side-effect", "incrementing-write-unguarded", "nondeterministic-key", "check-then-insert-race", "effect-before-record", "queue-add-without-job-id", "effect-missing-idempotency-key", "retry-loop-with-effect"]);
    const LOSS_RULES = new Set(["record-before-effect-no-tx"]);
    const confirmed: VerifyReport["confirmed"] = [];
    const lines = (f: Finding) => [f.location, f.effect?.location, ...(f.effect?.path ?? [])].filter(Boolean).map((l) => `${l!.file}:${l!.line}`);
    for (const f of opts.report.findings) {
      const want = new Set(lines(f));
      for (const s of scenarios) {
        const hitRepeat = DUP_RULES.has(f.rule) && s.repeated.some((x) => want.has(x.key));
        const hitLost = LOSS_RULES.has(f.rule) && s.lost.some((x) => want.has(x.key));
        if (hitRepeat || hitLost) {
          confirmed.push({ finding: f, scenario: s.name, how: hitRepeat ? "repeated" : "lost" });
          break;
        }
      }
    }
    const confirmedIds = new Set(confirmed.map((c) => c.finding.id));
    return { handler: handler.name, scenarios, confirmed, unconfirmed: opts.report.findings.filter((f) => !confirmedIds.has(f.id)), notes };
  } finally {
    globalThis.fetch = realFetch;
    process.env = realEnv;
    // jiti shares Node's require cache: drop the project's modules and the stubs so a later run starts clean.
    const cache = createRequire(import.meta.url).cache;
    for (const key of Object.keys(cache)) if (key.startsWith(opts.root) || key.startsWith(dir)) delete cache[key];
    rmSync(dir, { recursive: true, force: true });
  }
}

export function renderVerify(r: VerifyReport): string {
  const out = [`retrysafe verify (experimental): ${r.handler}`, ""];
  for (const s of r.scenarios) {
    const statuses = s.deliveries.map((d) => (d.error ? `error: ${d.error.slice(0, 60)}` : String(d.status ?? "-"))).join(", ");
    const bad = s.repeated.length || s.lost.length;
    out.push(`${bad ? "✖" : "✔"} ${s.name}  (responses: ${statuses})`);
    for (const x of s.repeated) out.push(`    repeated  ${x.module} ${x.call}  ${x.file ? `${x.file}:${x.line}` : ""}`);
    for (const x of s.lost) out.push(`    lost      ${x.module} ${x.call}  ${x.file ? `${x.file}:${x.line}` : ""}`);
  }
  out.push("", `Static findings confirmed: ${r.confirmed.length} of ${r.confirmed.length + r.unconfirmed.length}`);
  for (const c of r.confirmed) out.push(`  ✔ ${c.finding.rule} [${c.finding.id}] ${c.finding.location.file}:${c.finding.location.line}  (${c.how} in "${c.scenario}")`);
  for (const f of r.unconfirmed) out.push(`  · ${f.rule} [${f.id}] ${f.location.file}:${f.location.line}  (not reproduced)`);
  if (r.notes.length) out.push("", ...r.notes.map((n) => `note: ${n}`));
  out.push("", "Libraries in the effect catalog were stubbed; everything else in your code ran for real.");
  return out.join("\n");
}
