import { Node, SyntaxKind } from "ts-morph";
import { DEDUPE_NAME, PRISMA_MODULE, REDIS_MODULES, SQL_MODULES } from "../effects/catalog";
import { classifySql, insertTable } from "../effects/classify";
import { calleeOf, isFunctionLike, textOf, unwrap, type CallLike, type CallTarget } from "../project/resolve";
import type { GuardKind } from "../types";

export interface GuardPrimitive {
  kind: GuardKind;
  atomic: boolean | "unknown";
  description: string;
  /**
   * true if the call alone stops a duplicate (e.g. an insert into a unique processed-events table
   * throws on conflict). false if the result must be checked with an early exit to protect anything.
   */
  selfGuarding: boolean;
  /** Which result value signals a duplicate: a lookup finds a row (truthy); SET NX / conflict-ignoring insert returns null or 0 (falsy). */
  duplicateWhen: "truthy" | "falsy" | "unknown";
  /** Expressions the dedupe key is built from, for key-source tracking. */
  keyNodes?: Node[];
}

export interface CustomGuard {
  /** Callee text to match, e.g. "withIdempotency" or "dedupe.once". */
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

/**
 * The fields of a record that form its dedupe key. Prefer id/key-like fields; otherwise everything
 * except timestamps, which are expected to differ between deliveries.
 */
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

/** SQL parameters minus those bound to timestamp columns, when the INSERT column list lines up with them. */
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

/** Is this call, by itself, a dedupe primitive? */
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

  if (REDIS_MODULES.includes(module)) {
    if ((method === "set" && hasNxOption(args)) || method.toLowerCase() === "setnx") {
      return { kind: "redis-setnx", atomic: true, description: "Redis SET NX", selfGuarding: false, duplicateWhen: "falsy", keyNodes: args.slice(0, 1) };
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
    return { kind: "lookup-then-insert", atomic: false, description: "SELECT lookup", selfGuarding: false, duplicateWhen: "truthy", keyNodes: params };
  }
  const table = insertTable(sql);
  if (table && DEDUPE_NAME.test(table)) {
    const ignoresConflict = c.idempotent === true;
    return {
      kind: "unique-insert",
      atomic: ignoresConflict ? true : "unknown",
      description: `insert into ${table}`,
      // ON CONFLICT DO NOTHING never throws, so the row count must be checked.
      selfGuarding: !ignoresConflict,
      duplicateWhen: "falsy",
      keyNodes: params,
    };
  }
  return undefined;
}

/** A later write that marks the event handled without claiming it (redis SET without NX, update of a processed-events row). */
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

/** A call that undoes a claim: redis DEL, deleting the processed-events row. Only meaningful inside a catch block. */
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

/** A statement that unconditionally leaves the enclosing block (return, throw, continue, break). */
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

/**
 * Is `cond` true when the tracked value inside it is truthy? Handles `x`, `!x`, `x === null`,
 * `x !== null`, `count > 0`, `rowCount === 0`, ... Returns undefined when it cannot tell.
 */
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
      // `x === null` is true when x is falsy; `x === "OK"` is true when x is truthy.
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
