import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  ConfigError,
  DEFAULT_BASELINE,
  HandlerConfigError,
  RULES,
  analyze,
  applyBaseline,
  createBaseline,
  filterByChangedFiles,
  optionsFromConfig,
  parseBaseline,
  staleBaselineEntries,
  type AnalysisResult,
  type Confidence,
  type RetrysafeConfig,
  type Severity,
} from "@retrysafe/core";
import { renderExplain } from "./commands/explain";
import { runInit } from "./commands/init";
import { renderGithub } from "./github";
import { findConfig, loadConfig } from "./load-config";
import { renderMarkdown } from "./markdown";
import { renderSarif } from "./sarif";
import { renderTerminal } from "./terminal";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const HELP = `Usage:
  retrysafe [dir] [options]          Analyze the project
  retrysafe init [dir]               Create a starter retrysafe.config.ts
  retrysafe explain <id> [dir]       Failing sequence, why it happens, and the fix
  retrysafe rules                    List rules
  retrysafe verify <handler|id> [dir] (experimental) Deliver an event twice against stubbed libraries
  retrysafe fix [dir]                Preview codemods for findings (add idempotency keys, wrap with @retrysafe/guard)
  retrysafe live [dir]               Re-analyze on every save and show results live in the browser

Find webhook and queue handlers that double-charge, double-email, or drop events on retry.

Options:
  --handlers               List discovered at-least-once handlers only
  --effect-map             Show the effect map for every handler, not just flagged ones
  --format <fmt>           terminal (default), json, markdown, sarif, or github (Actions annotations)
  -o, --output <file>      Write the report to a file instead of stdout
  --config <file>          Config file (default: <dir>/retrysafe.config.{ts,js,mjs,json})
  --project <tsconfig>     Path to tsconfig.json (default: <dir>/tsconfig.json)
  --max-depth <n>          Call depth to follow into your own code (default: 6)
  --min-confidence <lvl>   low, medium (default), or high
  --baseline <file>        Baseline file (default: .retrysafe-baseline.json)
  --ignore-baseline        Report findings even if they are in the baseline
  --update-baseline        Record all current findings in the baseline and exit
  --changed <ref>          Only report handlers whose code changed since <ref> (e.g. origin/main)
  --staged                 Only report handlers touched by staged changes (pre-commit)
  --ci                     Exit 1 when a finding at or above --fail-on is reported
  --fail-on <severity>     error (default), warning, or info
  --payload <file>         verify: JSON event to deliver (default: a Stripe-shaped test event)
  --header <k=v>           verify: request header, repeatable
  --env <K=V>              verify: environment variable for the run, repeatable (e.g. a webhook secret)
  --quick                  verify: only the retry-after-success scenario
  --write                  fix: apply the changes (default: print a diff)
  --guard <module#export>  fix: @retrysafe/guard instance to wrap handlers with, e.g. "@/lib/guard#guard"
  --rule <id>              fix: only fix this rule, repeatable
  --port <n>               live: local port (default 4317)
  --site <url>             live: retrysafe site to view results on (default $RETRYSAFE_SITE_URL or https://retrysafe-frontend.vercel.app)
  --origin <url>           live: extra browser origin allowed to connect, repeatable
  --open                   live: open the browser automatically
  --new-token              live: issue a new connection token (invalidates links you shared)
  -v, --version            Print the version
  -h, --help               Show this help
`;

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      handlers: { type: "boolean" },
      "effect-map": { type: "boolean" },
      format: { type: "string", default: "terminal" },
      output: { type: "string", short: "o" },
      config: { type: "string" },
      project: { type: "string" },
      "max-depth": { type: "string" },
      "min-confidence": { type: "string" },
      baseline: { type: "string" },
      "ignore-baseline": { type: "boolean" },
      "update-baseline": { type: "boolean" },
      ci: { type: "boolean" },
      changed: { type: "string" },
      staged: { type: "boolean" },
      payload: { type: "string" },
      header: { type: "string", multiple: true },
      quick: { type: "boolean" },
      env: { type: "string", multiple: true },
      write: { type: "boolean" },
      port: { type: "string" },
      site: { type: "string" },
      origin: { type: "string", multiple: true },
      open: { type: "boolean" },
      "new-token": { type: "boolean" },
      guard: { type: "string" },
      rule: { type: "string", multiple: true },
      "fail-on": { type: "string", default: "error" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    write(HELP);
    return 0;
  }
  if (values.version) {
    write(`${VERSION}\n`);
    return 0;
  }

  const [command, ...rest] = positionals;
  if (command === "rules") {
    for (const r of RULES) write(`${r.id.padEnd(32)} ${r.severity.padEnd(8)} ${r.docs.summary}\n`);
    return 0;
  }
  if (command === "init") return runInit(resolveRoot(rest[0]));
  if (command === "live") {
    const { runLive } = await import("./live/command");
    return runLive({
      root: resolveRoot(rest[0]),
      port: values.port === undefined ? 4317 : Number(values.port),
      site: values.site,
      origins: values.origin ?? [],
      open: !!values.open,
      tsconfig: values.project,
      configPath: values.config ? path.resolve(values.config) : undefined,
      newToken: !!values["new-token"],
    });
  }
  const explainId = command === "explain" ? (rest[0] ?? fail("explain needs a finding id (shown in [brackets] in the report)")) : undefined;
  const verifyTarget = command === "verify" ? (rest[0] ?? fail("verify needs a handler name (as listed by --handlers) or a finding id")) : undefined;
  const isFix = command === "fix";
  const root = resolveRoot(command === "explain" || command === "verify" ? rest[1] : isFix ? rest[0] : command);

  const configPath = values.config ? path.resolve(values.config) : findConfig(root);
  if (values.config && !existsSync(configPath!)) fail(`config file not found: ${values.config}`);
  const config: RetrysafeConfig = configPath ? await loadConfig(configPath) : {};

  const format = values.format!;
  if (!["terminal", "json", "markdown", "sarif", "github"].includes(format)) fail("--format must be terminal, json, markdown, sarif, or github");
  const minConfidence = values["min-confidence"] as Confidence | undefined;
  if (minConfidence && !["low", "medium", "high"].includes(minConfidence)) fail("--min-confidence must be low, medium, or high");
  const failOn = values["fail-on"] as Severity;
  if (!(failOn in SEVERITY_RANK)) fail("--fail-on must be error, warning, or info");
  const maxDepth = values["max-depth"] === undefined ? undefined : Number(values["max-depth"]);
  if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 0)) fail("--max-depth must be a non-negative integer");

  if (isFix) {
    const { runFix } = await import("./fix/index");
    const { renderFix } = await import("./fix/render");
    const fixed = runFix({
      root,
      tsconfig: values.project,
      ...optionsFromConfig(config, { maxCallDepth: maxDepth, minConfidence }),
      guard: values.guard,
      onlyRules: values.rule,
    });
    if (values.write) for (const [file, text] of fixed.changes) writeFileSync(file, text);
    write(format === "json" ? `${JSON.stringify({ ...fixed, changes: undefined }, null, 2)}\n` : `${renderFix(fixed, !!values.write)}\n`);
    return 0;
  }

  let result: AnalysisResult = analyze({
    root,
    tsconfig: values.project,
    ...optionsFromConfig(config, { maxCallDepth: maxDepth, minConfidence }),
  });

  const baselinePath = path.resolve(root, values.baseline ?? config.baseline ?? DEFAULT_BASELINE);
  const handlerName = (id: string) => result.handlers.find((h) => h.handler.id === id)?.handler.name ?? id;

  if (values["update-baseline"]) {
    const baseline = createBaseline(result.findings, handlerName);
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    write(`Recorded ${baseline.findings.length} finding(s) in ${path.relative(process.cwd(), baselinePath)}\n`);
    return 0;
  }

  let staleCount = 0;
  if (!values["ignore-baseline"] && existsSync(baselinePath)) {
    const baseline = parseBaseline(readFileSync(baselinePath, "utf8"), path.basename(baselinePath));
    result = applyBaseline(result, baseline);
    staleCount = staleBaselineEntries(result, baseline).length;
  }

  if (values.changed || values.staged) {
    result = filterByChangedFiles(result, changedFiles(root, values.staged ? { staged: true } : { since: values.changed! }));
  }

  if (verifyTarget) {
    const report =
      result.handlers.find((h) => h.handler.name === verifyTarget) ??
      result.handlers.find((h) => h.findings.some((f) => f.id.startsWith(verifyTarget))) ??
      fail(`no handler named "${verifyTarget}" and no finding with that id; run retrysafe --handlers`);
    const payload = values.payload
      ? JSON.parse(readFileSync(path.resolve(values.payload), "utf8"))
      : {
          id: "evt_retrysafe_1",
          object: "event",
          type: report.eventTypes[0] ?? "test.event",
          created: 1_700_000_000,
          data: {
            id: "obj_retrysafe_1",
            reference: "ref_retrysafe_1",
            amount: 1000,
            currency: "usd",
            email: "test@example.com",
            customer: { id: "cus_retrysafe_1", email: "test@example.com" },
            metadata: { userId: "user_retrysafe_1", orderId: "order_retrysafe_1" },
            object: { id: "obj_retrysafe_1", customer: "cus_retrysafe_1", amount: 1000, email: "test@example.com", customer_email: "test@example.com", metadata: {} },
          },
          repository: { full_name: "octo/repo", id: 1 },
          sender: { login: "octocat" },
          resource: { id: "res_retrysafe_1", amount: 1000, user: "user_retrysafe_1" },
        };
    const pairs = (list: string[] | undefined) => Object.fromEntries((list ?? []).map((h) => [h.slice(0, h.indexOf("=")), h.slice(h.indexOf("=") + 1)]));
    const headers = pairs(values.header);
    const { renderVerify, runVerify } = await import("./verify/index");
    const v = await runVerify({ root, result, report, payload, headers, env: pairs(values.env), concurrent: !values.quick, crashSweep: !values.quick });
    write(format === "json" ? `${JSON.stringify(v, null, 2)}\n` : `${renderVerify(v)}\n`);
    process.exit(v.scenarios.some((s) => s.repeated.length || s.lost.length) && values.ci ? 1 : 0);
  }

  if (explainId) {
    const text = renderExplain(result, explainId);
    if (!text) fail(`no finding with id ${explainId}; run retrysafe to list finding ids`);
    write(`${text}\n`);
    return 0;
  }

  const report =
    format === "json"
      ? `${JSON.stringify(result, null, 2)}\n`
      : format === "markdown"
        ? renderMarkdown(result)
        : format === "sarif"
          ? renderSarif(result, VERSION)
          : format === "github"
            ? renderGithub(result)
          : `${renderTerminal(result, { handlersOnly: values.handlers, allEffectMaps: values["effect-map"], staleBaseline: staleCount })}\n`;
  if (values.output) {
    writeFileSync(path.resolve(values.output), report);
    process.stderr.write(`retrysafe: wrote ${values.output} (${result.findings.length} findings)\n`);
  } else {
    write(report);
  }

  const failing = result.findings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]);
  return values.ci && failing.length > 0 ? 1 : 0;
}

function changedFiles(root: string, opts: { since: string } | { staged: true }): string[] {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let out: string;
  let top: string;
  try {
    top = git(["rev-parse", "--show-toplevel"]).trim();
    if ("staged" in opts) {
      out = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
    } else {
      const base = git(["merge-base", opts.since, "HEAD"]).trim();
      out = git(["diff", "--name-only", "--diff-filter=ACMR", base]);
    }
  } catch (err) {
    fail(`could not list changed files with git (${(err as Error).message.split("\n")[0]})`);
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((f) => path.relative(root, path.join(top, f)).split(path.sep).join("/"))
    .filter((f) => !f.startsWith(".."));
}

function resolveRoot(dir: string | undefined): string {
  const root = path.resolve(dir ?? ".");
  if (!existsSync(root)) fail(`no such directory: ${root}`);
  return root;
}

function write(s: string): void {
  process.stdout.write(s);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const known = err instanceof UsageError || err instanceof ConfigError || err instanceof HandlerConfigError;
    process.stderr.write(`retrysafe: ${known ? (err as Error).message : (err as Error)?.stack ?? String(err)}\n`);
    process.exitCode = 2;
  },
);
