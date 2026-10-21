import path from "node:path";
import { IndentationText, Node, SyntaxKind, type Block, type SourceFile } from "ts-morph";
import {
  GUARD_LIBRARY,
  analyzeLoaded,
  isFunctionLike,
  loadProjects,
  mergeResults,
  resolveCall,
  unwrap,
  type AnalyzeOptions,
  type Finding,
  type FunctionLike,
  type HandlerReport,
  type SourceLocation,
} from "@retrysafe/core";
import { unifiedDiff } from "./diff";

export interface FixOptions extends AnalyzeOptions {
  root: string;
  /** Guard instance to wrap handlers with: "<module>#<export>", e.g. "@/lib/guard#guard" or "./src/lib/guard#guard". */
  guard?: string;
  /** Only fix these rules. */
  onlyRules?: string[];
}

export interface FixResult {
  applied: { rule: string; file: string; line: number; description: string }[];
  skipped: { rule: string; file: string; line: number; reason: string }[];
  diffs: { file: string; diff: string; after: string }[];
  /** Absolute paths of changed files with their new contents (written only with --write). */
  changes: Map<string, string>;
}

const KEY_RULES = new Set(["effect-missing-idempotency-key", "unguarded-side-effect", "effect-before-record", "retry-loop-with-effect", "queue-add-without-job-id"]);
const WRAP_RULES = new Set(["unguarded-side-effect", "incrementing-write-unguarded", "check-then-insert-race", "effect-before-record", "record-before-effect-no-tx", "non-atomic-multi-write"]);
const WRAPPABLE = new Set(["express", "fastify", "next-app-router", "next-pages-api", "bullmq", "bull"]);

interface Planned {
  file: SourceFile;
  /** Position used to order edits bottom-up and to re-find nodes when applying. */
  pos: number;
  finding: Finding;
  description: string;
  apply(): void;
}

function posOf(sf: SourceFile, loc: SourceLocation): number {
  return sf.compilerNode.getPositionOfLineAndCharacter(loc.line - 1, loc.column - 1);
}

/** The outermost node of `kind` that starts exactly at `pos`. */
function nodeAt<T extends Node>(sf: SourceFile, pos: number, pred: (n: Node) => n is T): T | undefined {
  let n: Node | undefined = sf.getDescendantAtPos(pos);
  let found: T | undefined;
  while (n && n.getStart() === pos) {
    if (pred(n)) found = n;
    n = n.getParent();
  }
  return found;
}

/** How to derive this handler's event key, and the raw id for idempotency keys on effects. */
interface EventId {
  /** Expression for guard.run's key, e.g. `eventKey.stripe(event)`. */
  key: string;
  /** Expression for an id inside a template, e.g. `event.id`; undefined when only header-based. */
  raw?: string;
  /** The key is only valid after this position (the event variable's declaration). */
  after: number;
}

function paramName(fn: FunctionLike, i: number): string | undefined {
  const p = (fn as unknown as { getParameters?: () => Node[] }).getParameters?.()[i];
  return p && Node.isParameterDeclaration(p) && Node.isIdentifier(p.getNameNode()) ? p.getName() : undefined;
}

function eventIdFor(fn: FunctionLike, report: HandlerReport): EventId | undefined {
  const body = fn.getBody();
  if (!body) return undefined;
  // const event = stripe.webhooks.constructEvent(...)
  for (const decl of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (decl.getFirstAncestor(isFunctionLike) !== fn) continue;
    const init = decl.getInitializer();
    if (init && /\.constructEvent(Async)?\(/.test(init.getText()) && Node.isIdentifier(decl.getNameNode())) {
      const name = decl.getName();
      return { key: `eventKey.stripe(${name})`, raw: `${name}.id`, after: decl.getEnd() };
    }
  }
  const h = report.handler;
  if (h.kind === "queue-worker" && (h.framework === "bullmq" || h.framework === "bull")) {
    const job = paramName(fn, 0);
    const queue = h.name.match(/queue "([^"]+)"/)?.[1] ?? "jobs";
    if (job) return { key: `eventKey.job(${JSON.stringify(queue)}, ${job})`, raw: `${job}.id`, after: body.getStart() + 1 };
  }
  const req = paramName(fn, 0);
  if (!req || h.kind !== "http-webhook") return undefined;
  const at = body.getStart() + 1;
  if (h.provider === "github") return { key: `eventKey.github(${req}.headers)`, after: at };
  if (h.provider === "shopify") return { key: `eventKey.shopify(${req}.headers)`, after: at };
  if (h.provider === "clerk" || h.provider === "resend") return { key: `eventKey.svix(${req}.headers)`, after: at };
  if ((h.provider === "paystack" || h.provider === "flutterwave") && (h.framework === "express" || h.framework === "fastify")) {
    return { key: `eventKey.${h.provider}(${req}.body)`, after: at };
  }
  return undefined;
}

function addNamedImport(sf: SourceFile, module: string, name: string): void {
  const existing = sf.getImportDeclarations().find((d) => d.getModuleSpecifierValue() === module && !d.isTypeOnly());
  if (existing) {
    if (!existing.getNamedImports().some((n) => n.getName() === name)) existing.addNamedImport(name);
    return;
  }
  sf.addImportDeclaration({ moduleSpecifier: module, namedImports: [name] });
}

/** Module specifier for the guard as seen from `sf`: relative paths are rebased, aliases kept verbatim. */
function guardSpecifier(sf: SourceFile, root: string, module: string): string {
  if (!module.startsWith(".")) return module;
  const abs = path.resolve(root, module);
  let rel = path.relative(path.dirname(sf.getFilePath()), abs).split(path.sep).join("/").replace(/\.[cm]?[jt]sx?$/, "");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** "postgresGuard" | "prismaGuard" | "redisGuard" | ..., read from the guard module's export, when it is in the project. */
function guardFactory(files: SourceFile[], root: string, module: string, exportName: string): string | undefined {
  if (!module.startsWith(".")) return undefined;
  const base = path.resolve(root, module).replace(/\.[cm]?[jt]sx?$/, "");
  const sf = files.find((f) => f.getFilePath().replace(/\.[cm]?[jt]sx?$/, "") === base || f.getFilePath().replace(/\/index\.[cm]?[jt]sx?$/, "") === base);
  const decl = sf?.getExportedDeclarations().get(exportName)?.[0];
  const init = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
  const u = init && unwrap(init);
  return u && Node.isCallExpression(u) ? u.getExpression().getText().split(".").pop() : undefined;
}

/** The project's indentation, from the first indented line of its files. */
function detectIndent(files: SourceFile[]): IndentationText {
  for (const f of files.slice(0, 20)) {
    const m = f.getFullText().match(/\n([ \t]+)\S/);
    if (!m) continue;
    if (m[1]!.startsWith("\t")) return IndentationText.Tab;
    return m[1]!.length >= 4 ? IndentationText.FourSpaces : IndentationText.TwoSpaces;
  }
  return IndentationText.TwoSpaces;
}

/** A statement's text with its original indentation removed from continuation lines. */
function dedented(node: Node): string {
  const sf = node.getSourceFile();
  const col = sf.getLineAndColumnAtPos(node.getStart()).column - 1;
  const lineStart = node.getStart() - col;
  const indent = sf.getFullText().slice(lineStart, node.getStart());
  return node
    .getText()
    .split("\n")
    .map((l, i) => (i > 0 && l.startsWith(indent) ? l.slice(indent.length) : l))
    .join("\n");
}

function hasReturn(nodes: Node[]): boolean {
  return nodes.some((s) => Node.isReturnStatement(s) || s.getDescendantsOfKind(SyntaxKind.ReturnStatement).some((r) => r.getFirstAncestor(isFunctionLike) === s.getFirstAncestor(isFunctionLike)));
}

/** Plan and apply fixes in memory; nothing is written. */
export function runFix(opts: FixOptions): FixResult {
  const projects = loadProjects(opts.root, opts.tsconfig);
  const results = projects.map((p) => analyzeLoaded(p, opts));
  const result = mergeResults(results);
  const allFiles = projects.flatMap((p) => p.sourceFiles);
  const fileOf = (rel: string) => allFiles.find((f) => f.getFilePath() === path.join(result.root, rel));
  const wanted = (rule: string) => !opts.onlyRules?.length || opts.onlyRules.includes(rule);
  for (const p of projects) p.project.manipulationSettings.set({ indentationText: detectIndent(allFiles) });

  const planned: Planned[] = [];
  const skipped: FixResult["skipped"] = [];
  const skip = (f: Finding, reason: string) => skipped.push({ rule: f.rule, file: f.location.file, line: f.location.line, reason });
  const [guardModule, guardExport = "guard"] = (opts.guard ?? "").split("#");
  const factory = opts.guard ? guardFactory(allFiles, result.root, guardModule!, guardExport) : undefined;

  for (const report of result.handlers) {
    const h = report.handler;
    const fnFile = h.fnLocation && fileOf(h.fnLocation.file);
    const fn = fnFile && h.fnLocation ? nodeAt(fnFile, posOf(fnFile, h.fnLocation), isFunctionLike) : undefined;
    const id = fn && eventIdFor(fn, report);
    let wrapped = false;

    for (const f of report.findings) {
      if (!wanted(f.rule)) continue;
      const sf = fileOf(f.location.file);
      if (!sf) continue;

      // 1. permanent failures answered with 5xx -> 400
      if (f.rule === "permanent-error-returns-5xx") {
        const pos = posOf(sf, f.location);
        planned.push({
          file: sf,
          pos,
          finding: f,
          description: "answer the permanent failure with 400",
          apply() {
            const start = sf.getDescendantAtPos(pos);
            const scope = start?.getFirstAncestor((a) => Node.isStatement(a)) ?? start;
            if (!scope) return;
            for (const n of [scope, ...scope.getDescendants()]) {
              if (Node.isCallExpression(n) && /(^|\.)(status|code|sendStatus)$/.test(n.getExpression().getText())) {
                const arg = n.getArguments()[0];
                if (arg && Node.isNumericLiteral(arg) && arg.getLiteralValue() >= 500) arg.replaceWithText("400");
              }
              if (Node.isPropertyAssignment(n) && /^(status|statusCode)$/.test(n.getName())) {
                const v = n.getInitializer();
                if (v && Node.isNumericLiteral(v) && v.getLiteralValue() >= 500) v.replaceWithText("400");
              }
            }
          },
        });
        continue;
      }

      // 2. idempotency key / job id on the call itself
      const e = f.effect;
      if (KEY_RULES.has(f.rule) && e?.acceptsIdempotencyKey && !e.hasIdempotencyKey && !e.module.startsWith("@aws-sdk/") && e.module !== "global:fetch" && e.module !== "axios") {
        if (e.path.length > 0) {
          skip(f, `the call is in a helper (${e.location.file}:${e.location.line}); pass the event id into it and set ${e.acceptsIdempotencyKey.field} there`);
        } else if (!id?.raw) {
          skip(f, "could not find a stable event or job id in the handler");
        } else {
          const callFile = fileOf(e.location.file)!;
          const pos = posOf(callFile, e.location);
          if (pos < id.after) {
            skip(f, "the event id is not available yet where the call is made");
          } else {
            const spec = e.acceptsIdempotencyKey;
            const scope = e.callee.split(".").slice(-2).join(".");
            const value = `\`${scope}:\${${id.raw}}\``;
            planned.push({
              file: callFile,
              pos,
              finding: f,
              description: `pass ${spec.field}: ${value}`,
              apply() {
                const call = nodeAt(callFile, pos, Node.isCallExpression);
                if (!call) return;
                const args = call.getArguments();
                const arg = args[spec.arg];
                if (!arg) {
                  while (call.getArguments().length < spec.arg) call.addArgument("undefined");
                  call.addArgument(`{ ${spec.field}: ${value} }`);
                } else if (Node.isObjectLiteralExpression(unwrap(arg))) {
                  (unwrap(arg) as import("ts-morph").ObjectLiteralExpression).addPropertyAssignment({ name: spec.field, initializer: value });
                } else {
                  arg.replaceWithText(`{ ...${arg.getText()}, ${spec.field}: ${value} }`);
                }
              },
            });
            if (f.rule !== "unguarded-side-effect" || e.kind === "payment") continue;
          }
        }
        if (f.rule !== "unguarded-side-effect") continue;
      }

      // 3. wrap the handler's work in guard.run(eventKey...)
      if (!WRAP_RULES.has(f.rule) || wrapped) continue;
      if (!opts.guard) {
        skip(f, "pass --guard <module>#<export> (a @retrysafe/guard instance) to wrap the handler");
        continue;
      }
      if (!fn || !WRAPPABLE.has(h.framework)) {
        skip(f, `wrapping ${h.framework} handlers is not supported yet`);
        continue;
      }
      if (!id) {
        skip(f, "could not determine a stable event id (wrap manually with guard.run(eventKey...))");
        continue;
      }
      const body = fn.getBody();
      if (!body || !Node.isBlock(body)) {
        skip(f, "the handler has no block body");
        continue;
      }
      if (/\.run\(\s*eventKey\./.test(body.getText())) continue;
      wrapped = true;
      const sfFn = fn.getSourceFile();
      // Start at the first top-level statement that leads to an effect, after the event id exists.
      const stmts = body.getStatements();
      const effectPositions = report.effects
        .filter((x) => x.kind !== "unknown")
        .map((x) => {
          const l = x.path[0] ?? x.location;
          const lf = fileOf(l.file);
          return lf === sfFn ? posOf(lf, l) : Number.POSITIVE_INFINITY;
        });
      const first = Math.min(...effectPositions);
      let k = stmts.findIndex((s) => s.getEnd() >= first);
      while (k >= 0 && k < stmts.length && stmts[k]!.getStart() < id.after) k++;
      if (k < 0 || k >= stmts.length) {
        skip(f, "no statements to wrap after the event id is available");
        continue;
      }
      const startPos = stmts[k]!.getStart();
      const fnPos = fn.getStart();
      const res = paramName(fn, 1);
      const framework = h.framework;
      planned.push({
        file: sfFn,
        pos: startPos,
        finding: f,
        description: `wrap the handler's work in ${guardExport}.run(${id.key}, ...)`,
        apply() {
          const fnNow = nodeAt(sfFn, fnPos, isFunctionLike)!;
          const block = fnNow.getBody() as Block;
          const all = block.getStatements();
          const from = all.findIndex((s) => s.getStart() >= startPos);
          const rest = all.slice(from);
          // With a transactional guard, route this handler's direct Prisma/pg writes through the transaction client.
          if (factory === "prismaGuard" || factory === "postgresGuard") {
            const module = factory === "prismaGuard" ? "@prisma/client" : "pg";
            const roots: Node[] = [];
            for (const s of rest) {
              for (const c of s.getDescendantsOfKind(SyntaxKind.CallExpression)) {
                const t = resolveCall(c);
                if (t.kind !== "external" || t.module !== module || t.chain[0]?.startsWith("$")) continue;
                let r: Node = c.getExpression();
                while (Node.isPropertyAccessExpression(r)) r = r.getExpression();
                if (Node.isIdentifier(r) && r.getText() !== "tx") roots.push(r);
              }
            }
            for (const r of roots.sort((a, b) => b.getStart() - a.getStart())) r.replaceWithText("tx");
          }
          const restNow = block.getStatements().slice(from);
          const returns = hasReturn(restNow);
          const unit = sfFn.getProject().manipulationSettings.getIndentationText();
          const inner = restNow
            .map((s) => dedented(s))
            .join("\n")
            .split("\n")
            .map((l) => (l ? unit + l : l))
            .join("\n");
          const txNote = factory === "prismaGuard" || factory === "postgresGuard" ? "" : `${unit}// retrysafe: with a database guard, do the writes below through \`tx\` so they commit with the claim.\n`;
          let after: string;
          if (framework === "express" || framework === "next-pages-api") {
            const r = res ?? "res";
            after = `if (result.status === "duplicate") return ${r}.status(200).end();\nif (result.status === "in-progress") return ${r}.status(409).end();`;
          } else if (framework === "fastify") {
            const r = res ?? "reply";
            after = `if (result.status === "duplicate") return ${r}.code(200).send();\nif (result.status === "in-progress") return ${r}.code(409).send();${returns ? "\nreturn result.value;" : ""}`;
          } else if (framework === "next-app-router") {
            after = `if (result.status !== "processed") return new Response(null, { status: result.status === "duplicate" ? 200 : 409 });${returns ? "\nreturn result.value;" : ""}`;
          } else {
            after = `if (result.status === "in-progress") throw new Error("retrysafe: another worker is processing this event; retry later");${returns ? '\nreturn result.status === "processed" ? result.value : undefined;' : ""}`;
          }
          const code = `const result = await ${guardExport}.run(${id.key}, async (tx) => {\n${txNote}${inner}\n});\n${after}`;
          block.removeStatements([from, all.length - 1]);
          block.addStatements(code);
          addNamedImport(sfFn, GUARD_LIBRARY, "eventKey");
          addNamedImport(sfFn, guardSpecifier(sfFn, result.root, guardModule!), guardExport);
        },
      });
    }
  }

  // Apply bottom-up per file so earlier positions stay valid.
  const originals = new Map<SourceFile, string>();
  const applied: FixResult["applied"] = [];
  for (const p of planned.sort((a, b) => (a.file === b.file ? b.pos - a.pos : a.file.getFilePath().localeCompare(b.file.getFilePath())))) {
    if (!originals.has(p.file)) originals.set(p.file, p.file.getFullText());
    try {
      p.apply();
      applied.push({ rule: p.finding.rule, file: p.finding.location.file, line: p.finding.location.line, description: p.description });
    } catch (err) {
      skipped.push({ rule: p.finding.rule, file: p.finding.location.file, line: p.finding.location.line, reason: `could not apply: ${(err as Error).message}` });
    }
  }

  const diffs: FixResult["diffs"] = [];
  const changes = new Map<string, string>();
  for (const [sf, before] of originals) {
    const after = sf.getFullText();
    if (after === before) continue;
    const rel = path.relative(result.root, sf.getFilePath()).split(path.sep).join("/");
    diffs.push({ file: rel, diff: unifiedDiff(rel, before, after), after });
    changes.set(sf.getFilePath(), after);
  }
  return { applied: applied.reverse(), skipped, diffs, changes };
}
