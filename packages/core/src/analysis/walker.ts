import path from "node:path";
import { Node, SyntaxKind, type IfStatement, type TryStatement } from "ts-morph";
import { EFFECT_CATALOG, VERIFY_CATALOG, chainMatches, findEntry, moduleMatches, type EffectCatalogEntry } from "../effects/catalog";
import { classify } from "../effects/classify";
import {
  exits,
  guardLibraryRun,
  guardPrimitive,
  markerWrite,
  matchCustomGuard,
  redisTtl,
  releaseCall,
  truthWhenTruthy,
  type CustomGuard,
  objectKeys,
  type GuardPrimitive,
} from "../guards/detect";
import {
  calleeOf,
  flatten,
  isFunctionLike,
  resolveCall,
  resolveIdentifier,
  unwrap,
  type CallLike,
  type FunctionLike,
} from "../project/resolve";
import type { CatchInfo, Check, Effect, Guard, KeySource, RecordStep, ResponseInfo, SourceLocation } from "../types";
import { classifyAwsSend } from "../effects/aws";
import { builderFamily, classifyBuilder, isOutermostCall } from "../effects/builders";
import { failureReason, isFloating, responseStatus, returnedStatus } from "./http";
import { traceKey } from "./keys";

/**
 * Parameters that carry the delivery itself (request, response, event, job) rather than a service:
 * `req.text()`, `res.send()`, `job.updateProgress()` are not side effects on the outside world.
 */
const DELIVERY_PARAM = /^(req|request|res|response|reply|ctx|context|c|event|evt|job|record|message|msg|payload|body|next)$/;
const DELIVERY_TYPE = /^(Request|NextRequest|NextApiRequest|NextApiResponse|Response|IncomingMessage|ServerResponse|FastifyRequest|FastifyReply|Context|Job|SQSRecord|SQSEvent)\b/;

/** Method names that usually mean a side effect, for calls we cannot resolve. */
const EFFECTFUL_NAME = /^(charge|pay|refund|transfer|payout|send|email|notify|sms|publish|enqueue|dispatch|emit|create|insert|save|persist|record|credit|debit|increment|decrement|grant|provision|fulfil|fulfill|ship|post|write|upsert|add|push|award|issue)/i;

export interface WalkOptions {
  root: string;
  maxCallDepth: number;
  customGuards: CustomGuard[];
  extraEffects: EffectCatalogEntry[];
}

interface Ctx {
  depth: number;
  path: SourceLocation[];
  /** Guards active at this point. Mutable: guards established mid-block are pushed for later statements. */
  guards: Guard[];
  /** Call site of the enclosing transaction, if any. */
  transaction?: string;
  stack: Set<Node>;
  /** Effects reached from here are not awaited by the handler. */
  floating?: boolean;
  /** Inside an in-code retry wrapper or loop. */
  retry?: SourceLocation;
  /** Branch lineage (see Effect.branch). */
  branch: string[];
}

/** Is the node inside a `try { ... }` block (not its catch/finally) within its own function? */
function insideTryBlock(node: Node): boolean {
  for (let a = node.getParent(), prev: Node = node; a && !isFunctionLike(a); prev = a, a = a.getParent()) {
    if (Node.isTryStatement(a) && a.getTryBlock() === prev) return true;
  }
  return false;
}

/** Keys of the object a write sets: Prisma `data`, Mongoose `$set`, or the object itself. */
function writeFields(arg: Node | undefined): string[] | undefined {
  const o = arg && unwrap(arg);
  if (!o || !Node.isObjectLiteralExpression(o)) return undefined;
  for (const name of ["data", "$set", "update"]) {
    const p = o.getProperty(name);
    if (p && Node.isPropertyAssignment(p)) return writeFields(p.getInitializer());
  }
  return objectKeys(o);
}

/** Libraries that re-run a function on failure. */
const RETRY_MODULES = new Set(["p-retry", "async-retry", "promise-retry", "exponential-backoff", "ts-retry-promise", "@lifeomic/attempt", "retry"]);
/** Calls that run their callback later, unawaited. */
const DETACHED = new Set(["setTimeout", "setImmediate", "nextTick", "queueMicrotask", "forEach"]);

export interface WalkResult {
  effects: Effect[];
  guards: Guard[];
  checks: Check[];
  records: RecordStep[];
  releases: SourceLocation[];
  responses: ResponseInfo[];
  catches: CatchInfo[];
}

export function location(node: Node, root: string): SourceLocation {
  const sf = node.getSourceFile();
  const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
  return { file: path.relative(root, sf.getFilePath()).split(path.sep).join("/"), line, column };
}

function argsOf(call: CallLike): Node[] {
  if (Node.isCallExpression(call)) return call.getArguments();
  if (Node.isTaggedTemplateExpression(call)) return [call.getTemplate()];
  return [];
}

/** The expression passed as the idempotency key option, if it is visible. */
function keyExpression(call: CallLike, arg: number, field: string): Node | undefined {
  const o = argsOf(call)[arg];
  const u = o && unwrap(o);
  if (!u || !Node.isObjectLiteralExpression(u)) return undefined;
  const p = u.getProperty(field);
  if (p && Node.isPropertyAssignment(p)) return p.getInitializer();
  if (p && Node.isShorthandPropertyAssignment(p)) return p.getNameNode();
  return undefined;
}

function hasKey(call: CallLike, arg: number, field: string): boolean {
  const a = argsOf(call)[arg];
  const o = a && unwrap(a);
  if (!o) return false;
  if (Node.isObjectLiteralExpression(o)) return !!o.getProperty(field) || o.getProperties().some((p) => Node.isSpreadAssignment(p));
  // A variable or call we cannot see into: assume the caller may pass the key.
  return !Node.isNullLiteral(o) && o.getText() !== "undefined";
}

/**
 * Walks a handler in execution order, following calls into project code to a bounded depth,
 * and records effects, guards, and checks along with the guards active on each path.
 *
 * Dominance is approximated structurally: a guard covers the statements after it in its own
 * block (and everything nested in them), or the branch it gates. A full CFG replaces this later.
 */
export class Walker {
  private effects: Effect[] = [];
  private guards: Guard[] = [];
  private checks: Check[] = [];
  private records: RecordStep[] = [];
  private releases: SourceLocation[] = [];
  private responses: ResponseInfo[] = [];
  private handlerFn: FunctionLike | undefined;
  private catches: CatchInfo[] = [];
  private order = 0;
  private seenGuardNodes = new Map<Node, Guard>();

  constructor(private opts: WalkOptions) {}

  /** Walk middleware (in order) then the handler; guards a middleware establishes before `next()` cover the handler. */
  run(fn: FunctionLike, middleware: FunctionLike[] = [], middlewareGuards: { node: Node; guard: GuardPrimitive }[] = []): WalkResult {
    const guards: Guard[] = middlewareGuards.map((m) => this.recordGuard(m.node, m.guard, { depth: 0, path: [], guards: [], stack: new Set(), branch: [] }));
    for (const mw of middleware) {
      guards.push(...this.walkFunction(mw, { depth: 0, path: [], guards: [...guards], stack: new Set([mw]), branch: [] }));
    }
    this.handlerFn = fn;
    this.walkFunction(fn, { depth: 0, path: [], guards, stack: new Set([fn]), branch: [] });
    return {
      effects: this.effects,
      guards: this.guards,
      checks: this.checks,
      records: this.records,
      releases: this.releases,
      responses: this.responses,
      catches: this.catches,
    };
  }

  private loc(node: Node): SourceLocation {
    return location(node, this.opts.root);
  }

  private keySources(nodes: Node[] | undefined): KeySource[] | undefined {
    if (!nodes?.length) return undefined;
    return nodes.flatMap((n) => traceKey(n, (x) => this.loc(x)));
  }

  /** Walk a function body; returns guards it establishes unconditionally at its top level. */
  private walkFunction(fn: FunctionLike, ctx: Ctx): Guard[] {
    const body = fn.getBody();
    if (!body) return [];
    if (Node.isBlock(body)) return this.walkStatements(body.getStatements(), ctx);
    const inner: Ctx = { ...ctx, guards: [...ctx.guards] };
    this.walk(body, inner);
    return inner.guards.slice(ctx.guards.length);
  }

  private walkStatements(stmts: Node[], parent: Ctx): Guard[] {
    const ctx: Ctx = { ...parent, guards: [...parent.guards] };
    const start = ctx.guards.length;
    for (const stmt of stmts) this.walk(stmt, ctx);
    return ctx.guards.slice(start);
  }

  private walk(node: Node, ctx: Ctx): void {
    // Nested declarations run only when called; calls are followed explicitly.
    if (Node.isFunctionDeclaration(node) || Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node)) {
      return;
    }
    if (Node.isBlock(node)) {
      this.walkStatements(node.getStatements(), ctx);
      return;
    }
    if (Node.isIfStatement(node)) {
      this.walkIf(node, ctx);
      return;
    }
    if (Node.isTryStatement(node)) {
      this.walkTry(node, ctx);
      return;
    }
    if (Node.isReturnStatement(node)) {
      const expr = node.getExpression();
      if (expr) this.walk(expr, ctx);
      const status = returnedStatus(expr);
      if (status !== undefined) this.pushResponse(node, status, ctx);
      return;
    }
    if (Node.isThrowStatement(node)) {
      node.forEachChild((c) => this.walk(c, ctx));
      // An uncaught throw in the handler body becomes a 500 from the framework.
      if (ctx.depth === 0 && !insideTryBlock(node)) {
        this.pushResponse(node, 500, ctx, true);
      }
      return;
    }
    if (Node.isForStatement(node) || Node.isWhileStatement(node) || Node.isDoStatement(node)) {
      // for (attempt = 0; attempt < 3; attempt++) { try { await charge(); break; } catch {} }
      const body = node.getStatement();
      const isRetryLoop = body.getDescendantsOfKind(SyntaxKind.TryStatement).some((t) =>
        t.getTryBlock().getDescendants().some((d) => Node.isBreakStatement(d) || Node.isReturnStatement(d)),
      );
      node.forEachChild((child) => this.walk(child, isRetryLoop ? { ...ctx, retry: ctx.retry ?? this.loc(node) } : ctx));
      return;
    }
    if (Node.isCaseClause(node) || Node.isDefaultClause(node)) {
      // Each case is its own scope: a guard in one case does not cover the others or the code after the switch.
      this.walkStatements(node.getStatements(), { ...ctx, branch: [...ctx.branch, `case@${node.getStart()}`] });
      return;
    }
    if (Node.isConditionalExpression(node)) {
      this.walk(node.getCondition(), ctx);
      this.walk(node.getWhenTrue(), { ...ctx, branch: [...ctx.branch, `cond@${node.getStart()}:t`] });
      this.walk(node.getWhenFalse(), { ...ctx, branch: [...ctx.branch, `cond@${node.getStart()}:f`] });
      return;
    }
    if (Node.isCallExpression(node) || Node.isTaggedTemplateExpression(node)) {
      this.walkCall(node, ctx);
      return;
    }
    if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
      // Inline callbacks (array.map, transaction bodies, ...) are assumed to run where they appear.
      this.walkFunction(node, { ...ctx, guards: [...ctx.guards] });
      return;
    }
    node.forEachChild((child) => this.walk(child, ctx));
  }

  /**
   * try { claim; work } catch { return } : guards established in the try block also cover the code after
   * the try statement when every path through the catch leaves the block (a duplicate never falls through),
   * or when there is no catch (the error propagates).
   */
  private walkTry(stmt: TryStatement, ctx: Ctx): void {
    const effectsBefore = this.effects.length;
    const established = this.walkStatements(stmt.getTryBlock().getStatements(), ctx);
    const tryEffects = this.effects.length - effectsBefore;
    const clause = stmt.getCatchClause();
    if (clause) {
      const responsesBefore = this.responses.length;
      this.walkStatements(clause.getBlock().getStatements(), { ...ctx, branch: [...ctx.branch, `catch@${clause.getStart()}`] });
      const block = clause.getBlock();
      const text = block.getText();
      this.catches.push({
        location: this.loc(clause),
        depth: ctx.depth,
        rethrows: block.getDescendantsOfKind(SyntaxKind.ThrowStatement).length > 0 || /\bnext\(\s*\w+/.test(text),
        statuses: this.responses.slice(responsesBefore).map((r) => r.status),
        tryEffects,
        tryEffectCallees: this.effects.slice(effectsBefore, effectsBefore + tryEffects).map((e) => e.callee),
        reason: failureReason(stmt.getTryBlock().getText()),
        reportsFailure: /batchItemFailures|moveToFailed|\.nack\(|\.retry\(|\breject\(|\.fail\(/.test(text),
      });
    }
    const fin = stmt.getFinallyBlock();
    if (fin) this.walkStatements(fin.getStatements(), ctx);
    if (!clause || exits(clause.getBlock())) ctx.guards.push(...established);
  }

  private walkIf(stmt: IfStatement, ctx: Ctx): void {
    const cond = stmt.getExpression();
    this.walk(cond, ctx);
    const found = this.checkedGuard(cond, ctx);
    const thenStmt = stmt.getThenStatement();
    const elseStmt = stmt.getElseStatement();
    const id = `if@${stmt.getStart()}`;
    const inThen = (c: Ctx): Ctx => ({ ...c, branch: [...ctx.branch, `${id}:then`] });
    const inElse = (c: Ctx): Ctx => ({ ...c, branch: [...ctx.branch, `${id}:else`] });

    // Does a duplicate delivery make this condition true (take `then`) or false (take `else`)?
    let dupTakesThen: boolean | undefined;
    if (found && found.guard.duplicateWhen !== "unknown") {
      const t = truthWhenTruthy(cond);
      dupTakesThen = t === undefined ? undefined : found.guard.duplicateWhen === "truthy" ? t : !t;
    }
    // `if (!user) return 404;` after a lookup is a not-found check, not a dedupe check.
    const notFoundCheck = dupTakesThen === false && exits(thenStmt) && !elseStmt;
    if (!found || notFoundCheck) {
      this.walk(thenStmt, inThen(ctx));
      if (elseStmt) this.walk(elseStmt, inElse(ctx));
      return;
    }
    const guard = this.recordGuard(found.node, found.guard, ctx);
    const guarded: Ctx = { ...ctx, guards: [...ctx.guards, guard] };

    if (dupTakesThen === false) {
      // if (claimed) { ...work... }  /  if (!existing) { ...work... }
      this.walk(thenStmt, inThen(guarded));
      if (elseStmt) this.walk(elseStmt, inElse(ctx));
      if (exits(elseStmt)) ctx.guards.push(guard);
      return;
    }
    // dupTakesThen true: if (existing) return;  undefined: polarity unknown, assume the usual early-exit shape.
    const thenExits = exits(thenStmt);
    this.walk(thenStmt, inThen(dupTakesThen === undefined && !thenExits ? guarded : ctx));
    if (elseStmt) this.walk(elseStmt, inElse(guarded));
    if (thenExits) ctx.guards.push(guard);
  }

  /** Find a dedupe primitive whose result feeds this condition, directly or through a local variable. */
  private checkedGuard(cond: Node, ctx: Ctx): { node: Node; guard: GuardPrimitive } | undefined {
    const calls: CallLike[] = [];
    const collect = (n: Node) => {
      if (Node.isCallExpression(n) || Node.isTaggedTemplateExpression(n)) calls.push(n);
      n.forEachDescendant((d) => {
        if (Node.isCallExpression(d) || Node.isTaggedTemplateExpression(d)) calls.push(d);
      });
    };
    collect(cond);
    const ids = Node.isIdentifier(cond) ? [cond] : cond.getDescendantsOfKind(SyntaxKind.Identifier);
    for (const id of ids) {
      for (const r of resolveIdentifier(id)) {
        if (!("decl" in r)) continue;
        const varDecl = Node.isVariableDeclaration(r.decl) ? r.decl : r.decl.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
        const init = varDecl?.getInitializer();
        if (init) collect(init);
      }
    }
    for (const call of calls) {
      const g = this.primitiveDeep(call, ctx.depth, new Set());
      if (g) return { node: call, guard: g };
    }
    return undefined;
  }

  /** A guard primitive in this call, or inside the project function it calls (bounded). */
  private primitiveDeep(call: CallLike, depth: number, seen: Set<Node>): GuardPrimitive | undefined {
    const target = resolveCall(call);
    const direct = guardPrimitive(call, target, this.opts.customGuards);
    if (direct) return direct;
    if (target.kind !== "local" || depth >= this.opts.maxCallDepth || seen.has(target.fn)) return undefined;
    seen.add(target.fn);
    const body = target.fn.getBody();
    if (!body) return undefined;
    for (const inner of [...body.getDescendantsOfKind(SyntaxKind.CallExpression), ...body.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)]) {
      const g = this.primitiveDeep(inner, depth + 1, seen);
      if (g) return { ...g, description: `${g.description} via ${target.name}()`, duplicateWhen: "unknown" };
    }
    return undefined;
  }

  private recordGuard(node: Node, primitive: GuardPrimitive, ctx: Ctx): Guard {
    const existing = this.seenGuardNodes.get(node);
    if (existing) return existing;
    const guard: Guard = {
      kind: primitive.kind,
      atomic: primitive.atomic,
      description: primitive.description,
      location: this.loc(node),
      path: ctx.path,
      order: this.order++,
      transaction: ctx.transaction,
      keySources: this.keySources(primitive.keyNodes),
      table: primitive.table,
      columns: primitive.columns,
      ttlSeconds: primitive.ttlSeconds,
    };
    this.seenGuardNodes.set(node, guard);
    this.guards.push(guard);
    if (guard.kind === "unique-insert" || guard.kind === "redis-setnx") {
      this.records.push({
        kind: "claim",
        description: guard.description,
        location: guard.location,
        path: guard.path,
        order: guard.order,
        transaction: guard.transaction,
        guard,
        ttlSeconds: guard.ttlSeconds,
      });
    }
    return guard;
  }

  private pushResponse(node: Node, status: number, ctx: Ctx, implicit = false): void {
    const stmt = Node.isStatement(node) ? node : node.getFirstAncestor((a) => Node.isStatement(a));
    const block = stmt?.getParent();
    const topLevel = ctx.depth === 0 && !!block && Node.isBlock(block) && block.getParent() === this.handlerFn;
    this.responses.push({ status, location: this.loc(node), order: this.order++, depth: ctx.depth, reason: this.branchReason(node), implicit, topLevel });
  }

  /** The failure an enclosing `if` or `catch` (within the same function) is handling. */
  private branchReason(node: Node): ResponseInfo["reason"] {
    for (let a = node.getParent(); a && !isFunctionLike(a); a = a.getParent()) {
      if (Node.isCatchClause(a)) {
        const t = a.getParent();
        return Node.isTryStatement(t) ? failureReason(t.getTryBlock().getText()) : "other";
      }
      if (Node.isIfStatement(a)) return failureReason(a.getExpression().getText());
    }
    return undefined;
  }

  private walkCall(call: CallLike, ctx: Ctx): void {
    const status = responseStatus(call);
    if (status !== undefined) this.pushResponse(call, status, ctx);
    if (isFloating(call) && !ctx.floating) ctx = { ...ctx, floating: true };
    const target = resolveCall(call);
    const library = guardLibraryRun(call, target);
    const custom = matchCustomGuard(call, this.opts.customGuards) ? guardPrimitive(call, target, this.opts.customGuards) : library;
    const isTransaction =
      target.kind === "external" && ["$transaction", "transaction"].includes(target.chain[target.chain.length - 1] ?? "");

    // Callee sub-expressions and arguments are evaluated (and callbacks typically run) around the call.
    const callee = calleeOf(call);
    if (!Node.isIdentifier(callee)) callee.forEachChild((c) => this.walk(c, ctx));

    const loc = this.loc(call);
    let argCtx: Ctx = isTransaction ? { ...ctx, transaction: `${loc.file}:${loc.line}:${loc.column}` } : ctx;
    const calleeName = flatten(callee).chain.at(-1) ?? callee.getText();
    if (DETACHED.has(calleeName)) argCtx = { ...argCtx, floating: true };
    if (target.kind === "external" && RETRY_MODULES.has(target.module)) argCtx = { ...argCtx, retry: argCtx.retry ?? loc };
    if (custom) {
      argCtx = { ...argCtx, guards: [...argCtx.guards, this.recordGuard(call, custom, ctx)] };
      // Database guards run the callback inside the claim's transaction.
      if (library?.transactional) argCtx = { ...argCtx, transaction: `${loc.file}:${loc.line}:${loc.column}` };
    }
    for (const arg of argsOf(call)) this.walk(arg, argCtx);

    if (custom) {
      // A bare configured guard (not wrapping a callback) is trusted to stop duplicates itself.
      if (!argsOf(call).some((a) => isFunctionLike(unwrap(a)))) ctx.guards.push(this.recordGuard(call, custom, ctx));
      return;
    }

    if (target.kind === "local") {
      const declared = this.configuredLocalEffect(call, target.fn);
      if (declared) {
        this.pushEffect(call, ctx, {
          kind: declared.kind,
          callee: callee.getText().replace(/\s+/g, ""),
          module: [declared.match.module].flat().join(", "),
          idempotent: declared.idempotent,
          note: "declared in config",
          acceptsIdempotencyKey: declared.acceptsKey,
          hasIdempotencyKey: !!declared.acceptsKey && hasKey(call, declared.acceptsKey.arg, declared.acceptsKey.field),
        });
        return;
      }
      if (ctx.stack.has(target.fn)) return;
      if (ctx.depth >= this.opts.maxCallDepth) {
        this.pushEffect(call, ctx, {
          kind: "unknown",
          callee: target.name,
          module: "(project)",
          idempotent: "unknown",
          note: `call depth limit (${this.opts.maxCallDepth}) reached`,
          hasIdempotencyKey: false,
        });
        return;
      }
      const established = this.walkFunction(target.fn, {
        ...ctx,
        depth: ctx.depth + 1,
        path: [...ctx.path, this.loc(call)],
        guards: [...ctx.guards],
        stack: new Set([...ctx.stack, target.fn]),
      });
      ctx.guards.push(...established);
      return;
    }

    if (target.kind === "unresolved") {
      this.unresolvedEffect(call, ctx);
      return;
    }
    if (target.kind !== "external") return;
    const { module, chain } = target;
    // A `tx` parameter used outside the walked callback (passed into a helper) still means "inside a transaction".
    const effectCtx: Ctx = { ...ctx, transaction: ctx.transaction ?? (target.viaTransaction ? "(transaction parameter)" : undefined) };

    const verify = findEntry(VERIFY_CATALOG, module, chain);
    if (verify) {
      this.checks.push({
        kind: "signature-verify",
        callee: callee.getText().replace(/\s+/g, ""),
        module,
        provider: verify.provider,
        location: this.loc(call),
        order: this.order++,
      });
      return;
    }

    if (releaseCall(call, target)) {
      if (call.getFirstAncestorByKind(SyntaxKind.CatchClause)) this.releases.push(this.loc(call));
      return;
    }

    const marker = markerWrite(call, target);
    if (marker) {
      this.records.push({
        kind: "marker-write",
        description: marker,
        location: this.loc(call),
        path: ctx.path,
        order: this.order++,
        transaction: effectCtx.transaction,
        ttlSeconds: redisTtl(chain.at(-1) ?? "", argsOf(call)),
      });
    }

    // Query builders (Drizzle, Knex, Mongoose): classify the whole chain once, at its outermost call.
    const family = builderFamily(module);
    if (family) {
      if (!isOutermostCall(call)) return;
      const b = classifyBuilder(family, call);
      if (b.type === "guard") {
        if (b.guard.selfGuarding) ctx.guards.push(this.recordGuard(call, b.guard, ctx));
      } else if (b.type === "effect") {
        this.pushEffect(call, effectCtx, { kind: b.kind, callee: b.label, module, idempotent: b.idempotent, note: b.note, hasIdempotencyKey: false, fields: b.fields });
      }
      return;
    }

    // AWS SDK v3: client.send(new XCommand(input))
    if (module.startsWith("@aws-sdk/") && chain[chain.length - 1] === "send") {
      const a = classifyAwsSend(call);
      if (a?.type === "guard") {
        ctx.guards.push(this.recordGuard(call, a.guard, ctx));
      } else if (a) {
        this.pushEffect(call, effectCtx, {
          kind: a.kind,
          callee: `${callee.getText().replace(/\s+/g, "")}(${a.label})`,
          module,
          idempotent: a.idempotent,
          note: a.note,
          acceptsIdempotencyKey: a.acceptsKey,
          hasIdempotencyKey: !!a.keyNode,
          keySources: a.keyNode ? this.keySources([a.keyNode]) : undefined,
        });
      }
      return;
    }

    const primitive = guardPrimitive(call, target, this.opts.customGuards);
    if (primitive) {
      if (primitive.selfGuarding) ctx.guards.push(this.recordGuard(call, primitive, ctx));
      return;
    }

    const entry = findEntry([...this.opts.extraEffects, ...EFFECT_CATALOG], module, chain);
    if (!entry) return;
    const sqlText = Node.isTaggedTemplateExpression(call) ? call.getTemplate().getText().slice(1, -1) : undefined;
    const c = classify(entry, argsOf(call), sqlText, chain);
    if (!c.isEffect) return;
    const acceptsKey = c.acceptsKey ?? entry.acceptsKey;
    const keyNode = c.keyNode ?? (entry.acceptsKey && keyExpression(call, entry.acceptsKey.arg, entry.acceptsKey.field));
    this.pushEffect(
      call,
      effectCtx,
      {
        kind: c.kind ?? entry.kind,
        callee: callee.getText().replace(/\s+/g, ""),
        module,
        idempotent: c.idempotent,
        note: c.note,
        acceptsIdempotencyKey: acceptsKey,
        hasIdempotencyKey: c.acceptsKey ? !!c.keyNode : !!entry.acceptsKey && hasKey(call, entry.acceptsKey.arg, entry.acceptsKey.field),
        keySources: keyNode ? this.keySources([keyNode]) : undefined,
        fields: (c.kind ?? entry.kind) === "db-write" ? writeFields(argsOf(call)[0]) : undefined,
      },
    );
  }

  /**
   * A call we cannot resolve (dependency injection, untyped parameters, `this.service.x()`) whose method
   * name suggests a side effect becomes an unknown effect, reported only at low confidence.
   */
  private unresolvedEffect(call: CallLike, ctx: Ctx): void {
    const { root, chain } = flatten(calleeOf(call));
    const method = chain[chain.length - 1];
    if (!method || !EFFECTFUL_NAME.test(method)) return;
    // Only receivers that come from outside the walked code: parameters, `this`, or their properties.
    const param = Node.isIdentifier(root)
      ? resolveIdentifier(root)
          .map((r) => ("decl" in r && Node.isParameterDeclaration(r.decl) ? r.decl : undefined))
          .find(Boolean)
      : undefined;
    const deliveryParam = !!param && (DELIVERY_PARAM.test(param.getName()) || DELIVERY_TYPE.test(param.getTypeNode()?.getText() ?? ""));
    const fromOutside = Node.isThisExpression(root) || (!!param && !deliveryParam);
    if (!fromOutside) return;
    this.pushEffect(call, ctx, {
      kind: "unknown",
      callee: calleeOf(call).getText().replace(/\s+/g, ""),
      module: "(unresolved)",
      idempotent: "unknown",
      note: "could not resolve the target; declare it under effects.extend if it has side effects",
      hasIdempotencyKey: false,
    });
  }

  /**
   * Config effects can name project code ({ module: "@/lib/billing", callee: "chargeCustomer" }). The module
   * matches the import specifier at the call site or the function's project path, with or without extension.
   */
  private configuredLocalEffect(call: CallLike, fn: FunctionLike): EffectCatalogEntry | undefined {
    if (!this.opts.extraEffects.length) return undefined;
    const { root, chain } = flatten(calleeOf(call));
    const modules = new Set<string>();
    if (Node.isIdentifier(root)) {
      for (const d of root.getSymbol()?.getDeclarations() ?? []) {
        const imp = d.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
        if (imp) modules.add(imp.getModuleSpecifierValue());
      }
    }
    const file = path.relative(this.opts.root, fn.getSourceFile().getFilePath()).split(path.sep).join("/");
    const bare = file.replace(/\.[cm]?[jt]sx?$/, "");
    for (const m of [file, bare, bare.replace(/\/index$/, "")]) modules.add(m);
    const fnName = (fn as { getName?: () => string | undefined }).getName?.();
    const chains = [[root.getText(), ...chain], ...(fnName ? [[fnName]] : [])];
    return this.opts.extraEffects.find(
      (e) => [...modules].some((m) => moduleMatches(e.match.module, m)) && chains.some((c) => chainMatches(e.match.callee, c)),
    );
  }

  private pushEffect(
    call: Node,
    ctx: Ctx,
    e: Pick<Effect, "kind" | "callee" | "module" | "idempotent" | "note" | "acceptsIdempotencyKey" | "hasIdempotencyKey" | "keySources" | "fields">,
  ): void {
    this.effects.push({
      ...e,
      floating: ctx.floating || undefined,
      retriedBy: ctx.retry,
      branch: ctx.branch,
      location: this.loc(call),
      path: ctx.path,
      inTransaction: !!ctx.transaction,
      transaction: ctx.transaction,
      protectedBy: [...ctx.guards],
      order: this.order++,
    });
  }
}
