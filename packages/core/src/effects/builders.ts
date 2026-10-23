import { Node } from "ts-morph";
import { objectKeys, type GuardPrimitive } from "../guards/detect";
import { textOf, unwrap, type CallLike } from "../project/resolve";
import type { EffectKind } from "../types";
import { DEDUPE_NAME } from "./catalog";

export function builderFamily(module: string): "drizzle" | "knex" | "mongoose" | undefined {
  if (module === "drizzle-orm" || module.startsWith("drizzle-orm/")) return "drizzle";
  if (module === "knex") return "knex";
  if (module === "mongoose") return "mongoose";
  return undefined;
}

export function isOutermostCall(call: Node): boolean {
  let n: Node = call;
  const parent = n.getParent();
  if (!parent || !Node.isPropertyAccessExpression(parent) || parent.getExpression() !== n) return true;
  n = parent;
  const grand = n.getParent();
  return !(grand && Node.isCallExpression(grand) && grand.getExpression() === n);
}

interface Segment {
  name: string;
  args: Node[];
}

export function chainSegments(call: CallLike): { root: Node; segments: Segment[] } {
  const segments: Segment[] = [];
  let n: Node = call;
  while (Node.isCallExpression(n)) {
    const callee = unwrap(n.getExpression());
    if (!Node.isPropertyAccessExpression(callee)) break;
    segments.unshift({ name: callee.getName(), args: n.getArguments() });
    n = unwrap(callee.getExpression());
    while (Node.isPropertyAccessExpression(n)) {
      segments.unshift({ name: n.getName(), args: [] });
      n = unwrap(n.getExpression());
    }
  }
  return { root: n, segments };
}

export type BuilderResult =
  | { type: "effect"; kind: EffectKind; idempotent: boolean | "unknown"; note?: string; label: string; fields?: string[] }
  | { type: "guard"; guard: GuardPrimitive }
  | { type: "none" };

const NOISE = new Set(["exec", "lean", "session", "returning", "then", "catch", "execute", "run", "all", "get", "toSQL", "transacting", "timeout"]);
const RELATIVE_SQL = /\$\{[^}]+\}\s*[+\-*]|[+\-*]\s*\$\{|\b(\w+)\s*[+\-*]\s*\d/;

function tableName(n: Node | undefined): string | undefined {
  if (!n) return undefined;
  return textOf(n) ?? unwrap(n).getText();
}

function guard(
  kind: GuardPrimitive["kind"],
  description: string,
  selfGuarding: boolean,
  duplicateWhen: GuardPrimitive["duplicateWhen"],
  atomic: GuardPrimitive["atomic"],
  keyNodes?: Node[],
  table?: string,
): BuilderResult {
  return { type: "guard", guard: { kind, description, selfGuarding, duplicateWhen, atomic, keyNodes, table, columns: objectKeys(keyNodes?.[0]) } };
}

function argText(segs: Segment[], name: string, index = 0): string {
  return segs.find((s) => s.name === name)?.args[index]?.getText() ?? "";
}

export function classifyBuilder(family: "drizzle" | "knex" | "mongoose", call: CallLike): BuilderResult {
  const r = classifyChain(family, call);
  if (r.type !== "effect") return r;
  const { segments } = chainSegments(call);
  const setArg = segments.find((s) => ["set", "update", "values", "insert", "merge"].includes(s.name))?.args[0] ?? segments.at(-1)?.args[1];
  const o = setArg && unwrap(setArg);
  const inner = o && Node.isObjectLiteralExpression(o) && o.getProperty("$set");
  return { ...r, fields: objectKeys(inner && Node.isPropertyAssignment(inner) ? inner.getInitializer() : setArg) };
}

function classifyChain(family: "drizzle" | "knex" | "mongoose", call: CallLike): BuilderResult {
  const { root, segments } = chainSegments(call);
  const segs = segments.filter((s) => !NOISE.has(s.name));
  const names = segs.map((s) => s.name);
  const has = (n: string) => names.includes(n);
  const label = `${root.getText().split("(")[0]}.${names.join("().")}()`;

  if (family === "drizzle") {
    const ins = segs.find((s) => s.name === "insert");
    if (ins) {
      const table = tableName(ins.args[0]) ?? "?";
      const values = segs.find((s) => s.name === "values")?.args[0];
      if (DEDUPE_NAME.test(table)) {
        return has("onConflictDoNothing")
          ? guard("unique-insert", `insert into ${table} (on conflict do nothing)`, false, "falsy", true, values ? [values] : undefined, table)
          : guard("unique-insert", `insert into ${table}`, true, "falsy", "unknown", values ? [values] : undefined, table);
      }
      if (has("onConflictDoNothing")) return { type: "effect", kind: "db-write", idempotent: true, note: "conflict-ignoring insert", label };
      if (has("onConflictDoUpdate")) {
        const relative = RELATIVE_SQL.test(argText(segs, "onConflictDoUpdate"));
        return { type: "effect", kind: "db-write", idempotent: !relative, note: relative ? "upsert with relative update" : "upsert", label };
      }
      return { type: "effect", kind: "db-write", idempotent: false, note: `plain insert into ${table}`, label };
    }
    if (has("update")) {
      const relative = RELATIVE_SQL.test(argText(segs, "set"));
      return { type: "effect", kind: "db-write", idempotent: !relative, note: relative ? "relative update" : undefined, label };
    }
    if (has("delete")) return { type: "effect", kind: "db-write", idempotent: true, label };
    if (has("select") || has("findFirst") || has("findMany")) {
      const table = tableName(segs.find((s) => s.name === "from")?.args[0]) ?? names[names.indexOf("query") + 1] ?? "?";
      return guard("lookup-then-insert", `lookup ${table}`, false, "truthy", false, undefined, table);
    }
    return { type: "none" };
  }

  if (family === "knex") {
    const table = (Node.isCallExpression(root) ? tableName(root.getArguments()[0]) : undefined) ?? tableName(segs.find((s) => s.name === "into" || s.name === "table" || s.name === "from")?.args[0]) ?? "?";
    if (has("insert")) {
      const ignore = has("onConflict") && has("ignore");
      if (DEDUPE_NAME.test(table)) return guard("unique-insert", `insert into ${table}${ignore ? " (on conflict ignore)" : ""}`, !ignore, "falsy", ignore ? true : "unknown", segs.find((s) => s.name === "insert")?.args, table);
      if (ignore) return { type: "effect", kind: "db-write", idempotent: true, note: "conflict-ignoring insert", label };
      if (has("merge")) return { type: "effect", kind: "db-write", idempotent: !RELATIVE_SQL.test(argText(segs, "merge")), note: "upsert", label };
      return { type: "effect", kind: "db-write", idempotent: false, note: `plain insert into ${table}`, label };
    }
    if (has("increment") || has("decrement")) return { type: "effect", kind: "db-write", idempotent: false, note: `${has("increment") ? "increment" : "decrement"} on ${table}`, label };
    if (has("update")) {
      const relative = /raw\([^)]*[+\-*]/.test(argText(segs, "update"));
      return { type: "effect", kind: "db-write", idempotent: !relative, note: relative ? "relative update" : undefined, label };
    }
    if (has("del") || has("delete")) return { type: "effect", kind: "db-write", idempotent: true, label };
    if (has("first") || has("select") || has("where")) return guard("lookup-then-insert", `lookup ${table}`, false, "truthy", false, undefined, table);
    return { type: "none" };
  }

  const modelNode = Node.isNewExpression(root) ? root.getExpression() : root;
  const model = modelNode.getText();
  const dedupe = DEDUPE_NAME.test(model);
  const op = names[names.length - 1] ?? "";
  if (["create", "insertMany", "save"].includes(op)) {
    const doc = Node.isNewExpression(root) ? root.getArguments()[0] : segs[segs.length - 1]?.args[0];
    if (dedupe) return guard("unique-insert", `insert into ${model}`, true, "falsy", "unknown", doc ? [doc] : undefined, model);
    return { type: "effect", kind: "db-write", idempotent: false, note: `insert into ${model}`, label };
  }
  if (["updateOne", "updateMany", "findOneAndUpdate", "findByIdAndUpdate", "replaceOne"].includes(op)) {
    const last = segs[segs.length - 1]!;
    const update = last.args[1]?.getText() ?? "";
    const upsert = /upsert\s*:\s*true/.test(last.args[2]?.getText() ?? "");
    if (dedupe && upsert) return guard("unique-insert", `upsert into ${model}`, false, "falsy", true, last.args[0] ? [last.args[0]] : undefined, model);
    const relative = /\$(inc|push|mul)\b/.test(update);
    return { type: "effect", kind: "db-write", idempotent: !relative, note: relative ? `${update.match(/\$(inc|push|mul)/)?.[0]} on ${model}` : undefined, label };
  }
  if (["deleteOne", "deleteMany", "findByIdAndDelete", "findOneAndDelete"].includes(op)) return { type: "effect", kind: "db-write", idempotent: true, label };
  if (["findOne", "findById", "exists", "countDocuments"].includes(op)) return guard("lookup-then-insert", `lookup ${model}.${op}`, false, "truthy", false, undefined, model);
  return { type: "none" };
}
