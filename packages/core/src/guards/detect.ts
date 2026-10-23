import { Node, SyntaxKind } from "ts-morph";
import { builderFamily, classifyBuilder, isOutermostCall } from "../effects/builders";
import { DEDUPE_NAME, PRISMA_MODULE, REDIS_MODULES, SQL_MODULES } from "../effects/catalog";
import { classifySql, insertTable } from "../effects/classify";
import { evalNumber } from "../analysis/http";
import { calleeOf, isFunctionLike, textOf, unwrap, type CallLike, type CallTarget } from "../project/resolve";
import type { GuardKind } from "../types";

export interface GuardPrimitive {
  kind: GuardKind;
  atomic: boolean | "unknown";
  description: string;
  selfGuarding: boolean;
  duplicateWhen: "truthy" | "falsy" | "unknown";
  keyNodes?: Node[];
  table?: string;
  columns?: string[];
  ttlSeconds?: number;
}

export function redisTtl(method: string, args: Node[]): number | undefined {
  if (method.toLowerCase() === "setex") return evalNumber(args[1]);
  for (let i = 2; i < args.length; i++) {
    const a = unwrap(args[i]!);
    if (Node.isStringLiteral(a)) {
      const flag = a.getLiteralValue().toUpperCase();
      if (flag === "EX") return evalNumber(args[i + 1]);
      if (flag === "PX") return (evalNumber(args[i + 1]) ?? Number.NaN) / 1000 || undefined;
    }
    if (Node.isObjectLiteralExpression(a)) {
      for (const p of a.getProperties()) {
        if (!Node.isPropertyAssignment(p)) continue;
        const name = p.getName().toUpperCase();
        if (name === "EX") return evalNumber(p.getInitializer());
        if (name === "PX") return (evalNumber(p.getInitializer()) ?? Number.NaN) / 1000 || undefined;
      }
    }
  }
  return undefined;
}

export function objectKeys(node: Node | undefined): string[] | undefined {
  const o = node && unwrap(node);
  if (!o) return undefined;
  if (Node.isArrayLiteralExpression(o)) return objectKeys(o.getElements()[0]);
  if (!Node.isObjectLiteralExpression(o)) return undefined;
  return o.getProperties().flatMap((p) => (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p) ? [p.getName().replace(/^["'`]|["'`]$/g, "")] : []));
}

export interface CustomGuard {
  callee: string;
  keyArg?: number;
  atomic?: boolean;
}

const PRISMA_LOOKUPS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "count"]);

function argsOf(call: CallLike): Node[] {
  if (Node.isCallExpression(call)) return call.getArguments();
  if (Node.isTaggedTemplateExpression(call)) return [call.getTemplate()];
  return [];
}

function objectProp(obj: Node | undefined, name: string): Node | undefined {
  const o = obj && unwrap(obj);
  if (!o || !Node.isObjectLiteralExpression(o)) return undefined;
  const p = o.getProperty(name);
  return p && Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
}

const KEY_FIELD = /^(id|key)$|key$|id$|_id$/i;
const TIMESTAMP_FIELD = /(at|_at|date|time|timestamp|expires?)$/i;

function keyFields(obj: Node | undefined): Node[] {
  const o = obj && unwrap(obj);
  if (!o) return [];
  if (!Node.isObjectLiteralExpression(o)) return [o];
  const props = o.getProperties().filter((p) => Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p));
  const named = (p: (typeof props)[number]) => (p as { getName(): string }).getName();
  const value = (p: (typeof props)[number]) => (Node.isPropertyAssignment(p) ? p.getInitializer() : (p as { getNameNode(): Node }).getNameNode());
  const keys = props.filter((p) => KEY_FIELD.test(named(p)));
  const chosen = keys.length ? keys : props.filter((p) => !TIMESTAMP_FIELD.test(named(p)));
  return chosen.map(value).filter((n): n is Node => !!n);
}

function sqlKeyParams(sql: string, params: Node | undefined): Node[] {
  const p = params && unwrap(params);
  if (!p) return [];
  if (!Node.isArrayLiteralExpression(p)) return [p];
  const elements = p.getElements();
  const cols = sql.match(/\binsert\s+(?:ignore\s+)?into\s+[\w."`]+\s*\(([^)]*)\)/i)?.[1]?.split(",").map((c) => c.trim().replace(/["`]/g, ""));
  if (!cols || cols.length !== elements.length) return elements;
  return elements.filter((_, i) => !TIMESTAMP_FIELD.test(cols[i] ?? ""));
}

function hasNxOption(args: Node[]): boolean {
  return args.slice(2).some((a) => {
    const u = unwrap(a);
    if (Node.isStringLiteral(u)) return u.getLiteralValue().toUpperCase() === "NX";
    if (Node.isObjectLiteralExpression(u)) {
      return u.getProperties().some((p) => Node.isPropertyAssignment(p) && p.getName().toUpperCase() === "NX" && p.getInitializer()?.getText() === "true");
    }
    return false;
  });
}

export function matchCustomGuard(call: CallLike, guards: CustomGuard[]): CustomGuard | undefined {
  const text = calleeOf(call).getText().replace(/\s+/g, "");
  return guards.find((g) => text === g.callee || text.endsWith(`.${g.callee}`));
}

export function guardPrimitive(call: CallLike, target: CallTarget, custom: CustomGuard[]): GuardPrimitive | undefined {
  const customGuard = matchCustomGuard(call, custom);
  if (customGuard) {
    const keyArg = argsOf(call)[customGuard.keyArg ?? 0];
    return {
      kind: "middleware",
      atomic: customGuard.atomic ?? true,
      description: `${customGuard.callee}() (configured guard)`,
      selfGuarding: true,
      duplicateWhen: "unknown",
      keyNodes: keyArg && !isFunctionLike(unwrap(keyArg)) ? [keyArg] : undefined,
    };
  }
  if (target.kind !== "external") return undefined;
  const { module, chain } = target;
  const method = chain[chain.length - 1] ?? "";
  const args = argsOf(call);

  const family = builderFamily(module);
  if (family) {
    if (!isOutermostCall(call)) return undefined;
    const b = classifyBuilder(family, call);
    return b.type === "guard" ? b.guard : undefined;
  }

  if (REDIS_MODULES.includes(module)) {
    if ((method === "set" && hasNxOption(args)) || method.toLowerCase() === "setnx") {
      return { kind: "redis-setnx", atomic: true, description: "Redis SET NX", selfGuarding: false, duplicateWhen: "falsy", keyNodes: args.slice(0, 1), ttlSeconds: redisTtl(method, args) };
    }
    if (method === "get" || method === "exists") {
      return { kind: "lookup-then-insert", atomic: false, description: `Redis ${method.toUpperCase()} lookup`, selfGuarding: false, duplicateWhen: "truthy", keyNodes: args.slice(0, 1) };
    }
    return undefined;
  }

  if (module === PRISMA_MODULE && chain.length >= 2) {
    const model = chain[chain.length - 2] ?? "";
    if (PRISMA_LOOKUPS.has(method)) {
      return {
        kind: "lookup-then-insert",
        atomic: false,
        description: `lookup ${model}.${method}`,
        selfGuarding: false,
        duplicateWhen: "truthy",
        keyNodes: keyFields(objectProp(args[0], "where")),
        table: model,
        columns: objectKeys(objectProp(args[0], "where")),
      };
    }
    if ((method === "create" || method === "createMany") && DEDUPE_NAME.test(model)) {
      const skipDuplicates = /skipDuplicates\s*:\s*true/.test(args[0]?.getText() ?? "");
      return {
        kind: "unique-insert",
        atomic: "unknown",
        description: `insert into ${model}`,
        selfGuarding: method === "create" && !skipDuplicates,
        duplicateWhen: "falsy",
        keyNodes: keyFields(objectProp(args[0], "data")),
        table: model,
        columns: objectKeys(objectProp(args[0], "data")),
      };
    }
    if (method === "$executeRaw" || method === "$executeRawUnsafe" || method === "$queryRaw") {
      return sqlGuard(textOf(args[0]), args[1]);
    }
    return undefined;
  }

  if (SQL_MODULES.includes(module) && (method === "query" || method === "execute")) {
    return sqlGuard(textOf(args[0]), args[1]);
  }
  return undefined;
}

function sqlGuard(sql: string | undefined, paramsArg: Node | undefined): GuardPrimitive | undefined {
  if (!sql) return undefined;
  const c = classifySql(sql);
  const params = sqlKeyParams(sql, paramsArg);
  if (!c.isEffect) {
    const from = sql.match(/\bfrom\s+["`]?([\w.]+)/i)?.[1];
    return { kind: "lookup-then-insert", atomic: false, description: `SELECT lookup${from ? ` on ${from}` : ""}`, selfGuarding: false, duplicateWhen: "truthy", keyNodes: params, table: from };
  }
  const table = insertTable(sql);
  if (table && DEDUPE_NAME.test(table)) {
    const ignoresConflict = c.idempotent === true;
    return {
      kind: "unique-insert",
      atomic: ignoresConflict ? true : "unknown",
      description: `insert into ${table}`,
      selfGuarding: !ignoresConflict,
      duplicateWhen: "falsy",
      keyNodes: params,
      table,
      columns: sql.match(/\binsert\s+(?:ignore\s+)?into\s+[\w."`]+\s*\(([^)]*)\)/i)?.[1]?.split(",").map((c) => c.trim().replace(/["`]/g, "")),
    };
  }
  return undefined;
}

export const GUARD_LIBRARY = "@retrysafe/guard";
const GUARD_ADAPTERS = new Set(["withGuard", "withGuardRoute", "withGuardJob"]);

export function guardLibraryRun(call: CallLike, target: CallTarget): (GuardPrimitive & { transactional: boolean }) | undefined {
  if (target.kind !== "external" || target.module !== GUARD_LIBRARY || target.chain[target.chain.length - 1] !== "run") return undefined;
  const callee = calleeOf(call);
  const receiver = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : callee;
  let factory = "guard";
  const sym = Node.isIdentifier(receiver) ? receiver.getSymbol() : undefined;
  for (const d of (sym?.isAlias() ? sym.getAliasedSymbol() : sym)?.getDeclarations() ?? []) {
    const init = Node.isVariableDeclaration(d) ? d.getInitializer() : undefined;
    const u = init && unwrap(init);
    if (u && Node.isCallExpression(u)) factory = u.getExpression().getText().split(".").pop() ?? factory;
  }
  return {
    kind: "middleware",
    atomic: true,
    description: `${factory}.run() (@retrysafe/guard)`,
    selfGuarding: true,
    duplicateWhen: "unknown",
    keyNodes: argsOf(call).slice(0, 1),
    transactional: factory === "postgresGuard" || factory === "prismaGuard",
  };
}

export function guardLibraryAdapter(call: Node): GuardPrimitive | undefined {
  if (!Node.isCallExpression(call)) return undefined;
  const callee = call.getExpression();
  const name = callee.getText().split(".").pop() ?? "";
  if (!GUARD_ADAPTERS.has(name)) return undefined;
  const target = resolveImportModule(callee);
  if (target !== GUARD_LIBRARY) return undefined;
  return { kind: "middleware", atomic: true, description: `${name}() (@retrysafe/guard)`, selfGuarding: true, duplicateWhen: "unknown", keyNodes: call.getArguments().slice(1, 2) };
}

function resolveImportModule(n: Node): string | undefined {
  const root = Node.isPropertyAccessExpression(n) ? n.getExpression() : n;
  if (!Node.isIdentifier(root)) return undefined;
  for (const d of root.getSymbol()?.getDeclarations() ?? []) {
    const imp = d.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    if (imp) return imp.getModuleSpecifierValue();
  }
  return undefined;
}

export function markerWrite(call: CallLike, target: CallTarget): string | undefined {
  if (target.kind !== "external") return undefined;
  const { module, chain } = target;
  const method = chain[chain.length - 1] ?? "";
  const args = argsOf(call);
  if (REDIS_MODULES.includes(module) && (method === "set" || method === "setex") && !hasNxOption(args)) return `Redis ${method.toUpperCase()}`;
  if (module === PRISMA_MODULE && chain.length >= 2) {
    const model = chain[chain.length - 2] ?? "";
    if (["update", "upsert", "updateMany"].includes(method) && DEDUPE_NAME.test(model)) return `${model}.${method}`;
  }
  return undefined;
}

export function releaseCall(call: CallLike, target: CallTarget): boolean {
  if (target.kind !== "external") return false;
  const { module, chain } = target;
  const method = chain[chain.length - 1] ?? "";
  if (REDIS_MODULES.includes(module)) return method === "del" || method === "unlink";
  if (module === PRISMA_MODULE && chain.length >= 2) {
    return (method === "delete" || method === "deleteMany") && DEDUPE_NAME.test(chain[chain.length - 2] ?? "");
  }
  if (SQL_MODULES.includes(module) && (method === "query" || method === "execute")) {
    const sql = textOf(argsOf(call)[0]) ?? "";
    const m = sql.match(/\bdelete\s+from\s+["`]?([\w.]+)/i);
    return !!m && DEDUPE_NAME.test(m[1] ?? "");
  }
  return false;
}

export function exits(stmt: Node | undefined): boolean {
  if (!stmt) return false;
  if (Node.isReturnStatement(stmt) || Node.isThrowStatement(stmt) || Node.isContinueStatement(stmt) || Node.isBreakStatement(stmt)) {
    return true;
  }
  if (Node.isBlock(stmt)) return stmt.getStatements().some((s) => exits(s));
  if (Node.isIfStatement(stmt)) return exits(stmt.getThenStatement()) && exits(stmt.getElseStatement());
  return false;
}

const FALSY_LITERALS = new Set(["null", "undefined", "0", "false", '""', "''"]);

export function truthWhenTruthy(cond: Node): boolean | undefined {
  const e = unwrap(cond);
  if (Node.isPrefixUnaryExpression(e) && e.getOperatorToken() === SyntaxKind.ExclamationToken) {
    const inner = truthWhenTruthy(e.getOperand());
    return inner === undefined ? undefined : !inner;
  }
  if (Node.isBinaryExpression(e)) {
    const op = e.getOperatorToken().getText();
    const left = unwrap(e.getLeft()).getText();
    const right = unwrap(e.getRight()).getText();
    const OK = /^["'`]OK["'`]$/i;
    const literal = FALSY_LITERALS.has(right) || OK.test(right) ? right : FALSY_LITERALS.has(left) || OK.test(left) ? left : undefined;
    if (literal !== undefined) {
      const eqWhenTruthy = OK.test(literal);
      if (op === "===" || op === "==") return eqWhenTruthy;
      if (op === "!==" || op === "!=") return !eqWhenTruthy;
    }
    if ((op === ">" && right === "0") || (op === ">=" && right === "1")) return true;
    if ((op === "<" && right === "1") || (op === "<=" && right === "0")) return false;
    return undefined;
  }
  if (Node.isIdentifier(e) || Node.isCallExpression(e) || Node.isPropertyAccessExpression(e) || Node.isTaggedTemplateExpression(e)) {
    return true;
  }
  return undefined;
}
