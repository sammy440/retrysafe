import path from "node:path";
import { Node, SyntaxKind, type IfStatement } from "ts-morph";
import { EFFECT_CATALOG, VERIFY_CATALOG, findEntry, type EffectCatalogEntry } from "../effects/catalog";
import { classify } from "../effects/classify";
import {
  exits,
  guardPrimitive,
  markerWrite,
  matchCustomGuard,
  releaseCall,
  truthWhenTruthy,
  type CustomGuard,
  type GuardPrimitive,
} from "../guards/detect";
import {
  calleeOf,
  isFunctionLike,
  resolveCall,
  resolveIdentifier,
  unwrap,
  type CallLike,
  type FunctionLike,
} from "../project/resolve";
import type { Check, Effect, Guard, KeySource, RecordStep, SourceLocation } from "../types";
import { traceKey } from "./keys";

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
}

export interface WalkResult {
  effects: Effect[];
  guards: Guard[];
  checks: Check[];
  records: RecordStep[];
  releases: SourceLocation[];
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
  private order = 0;
  private seenGuardNodes = new Map<Node, Guard>();

  constructor(private opts: WalkOptions) {}

  run(fn: FunctionLike): WalkResult {
    this.walkFunction(fn, { depth: 0, path: [], guards: [], stack: new Set([fn]) });
    return { effects: this.effects, guards: this.guards, checks: this.checks, records: this.records, releases: this.releases };
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

  private walkIf(stmt: IfStatement, ctx: Ctx): void {
    const cond = stmt.getExpression();
    this.walk(cond, ctx);
    const found = this.checkedGuard(cond, ctx);
    const thenStmt = stmt.getThenStatement();
    const elseStmt = stmt.getElseStatement();

    // Does a duplicate delivery make this condition true (take `then`) or false (take `else`)?
    let dupTakesThen: boolean | undefined;
    if (found && found.guard.duplicateWhen !== "unknown") {
      const t = truthWhenTruthy(cond);
      dupTakesThen = t === undefined ? undefined : found.guard.duplicateWhen === "truthy" ? t : !t;
    }
    // `if (!user) return 404;` after a lookup is a not-found check, not a dedupe check.
    const notFoundCheck = dupTakesThen === false && exits(thenStmt) && !elseStmt;
    if (!found || notFoundCheck) {
      this.walk(thenStmt, ctx);
      if (elseStmt) this.walk(elseStmt, ctx);
      return;
    }
    const guard = this.recordGuard(found.node, found.guard, ctx);
    const guarded: Ctx = { ...ctx, guards: [...ctx.guards, guard] };

    if (dupTakesThen === false) {
      // if (claimed) { ...work... }  /  if (!existing) { ...work... }
      this.walk(thenStmt, guarded);
      if (elseStmt) this.walk(elseStmt, ctx);
      if (exits(elseStmt)) ctx.guards.push(guard);
      return;
    }
    // dupTakesThen true: if (existing) return;  undefined: polarity unknown, assume the usual early-exit shape.
    const thenExits = exits(thenStmt);
    this.walk(thenStmt, dupTakesThen === undefined && !thenExits ? guarded : ctx);
    if (elseStmt) this.walk(elseStmt, guarded);
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
      });
    }
    return guard;
  }

  private walkCall(call: CallLike, ctx: Ctx): void {
    const target = resolveCall(call);
    const custom = matchCustomGuard(call, this.opts.customGuards);
    const isTransaction =
      target.kind === "external" && ["$transaction", "transaction"].includes(target.chain[target.chain.length - 1] ?? "");

    // Callee sub-expressions and arguments are evaluated (and callbacks typically run) around the call.
    const callee = calleeOf(call);
    if (!Node.isIdentifier(callee)) callee.forEachChild((c) => this.walk(c, ctx));

    const loc = this.loc(call);
    let argCtx: Ctx = isTransaction ? { ...ctx, transaction: `${loc.file}:${loc.line}:${loc.column}` } : ctx;
    if (custom) {
      const g = guardPrimitive(call, target, this.opts.customGuards)!;
      argCtx = { ...argCtx, guards: [...argCtx.guards, this.recordGuard(call, g, ctx)] };
    }
    for (const arg of argsOf(call)) this.walk(arg, argCtx);

    if (custom) {
      // A bare configured guard (not wrapping a callback) is trusted to stop duplicates itself.
      if (!argsOf(call).some((a) => isFunctionLike(unwrap(a)))) ctx.guards.push(this.recordGuard(call, guardPrimitive(call, target, this.opts.customGuards)!, ctx));
      return;
    }

    if (target.kind === "local") {
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
      this.records.push({ kind: "marker-write", description: marker, location: this.loc(call), path: ctx.path, order: this.order++, transaction: effectCtx.transaction });
    }

    const primitive = guardPrimitive(call, target, this.opts.customGuards);
    if (primitive) {
      if (primitive.selfGuarding) ctx.guards.push(this.recordGuard(call, primitive, ctx));
      return;
    }

    const entry = findEntry([...this.opts.extraEffects, ...EFFECT_CATALOG], module, chain);
    if (!entry) return;
    const sqlText = Node.isTaggedTemplateExpression(call) ? call.getTemplate().getText().slice(1, -1) : undefined;
    const c = classify(entry, argsOf(call), sqlText);
    if (!c.isEffect) return;
    const keyNode = entry.acceptsKey && keyExpression(call, entry.acceptsKey.arg, entry.acceptsKey.field);
    this.pushEffect(
      call,
      effectCtx,
      {
        kind: entry.kind,
        callee: callee.getText().replace(/\s+/g, ""),
        module,
        idempotent: c.idempotent,
        note: c.note,
        acceptsIdempotencyKey: entry.acceptsKey,
        hasIdempotencyKey: !!entry.acceptsKey && hasKey(call, entry.acceptsKey.arg, entry.acceptsKey.field),
        keySources: keyNode ? this.keySources([keyNode]) : undefined,
      },
    );
  }

  private pushEffect(
    call: Node,
    ctx: Ctx,
    e: Pick<Effect, "kind" | "callee" | "module" | "idempotent" | "note" | "acceptsIdempotencyKey" | "hasIdempotencyKey" | "keySources">,
  ): void {
    this.effects.push({
      ...e,
      location: this.loc(call),
      path: ctx.path,
      inTransaction: !!ctx.transaction,
      transaction: ctx.transaction,
      protectedBy: [...ctx.guards],
      order: this.order++,
    });
  }
}
