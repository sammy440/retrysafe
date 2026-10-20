import { Node } from "ts-morph";
import { textOf, unwrap } from "../project/resolve";
import type { EffectCatalogEntry } from "./catalog";

export interface Classification {
  /** false means "not an effect" (e.g. a SELECT through a generic query method). */
  isEffect: boolean;
  idempotent: boolean | "unknown";
  note?: string;
}

const PRISMA_NON_IDEMPOTENT_OPS = new Set(["increment", "decrement", "multiply", "divide", "push"]);

export function classify(entry: EffectCatalogEntry, args: Node[], sqlText?: string): Classification {
  if (entry.classify === "prisma-write") return classifyPrisma(entry, args);
  if (entry.classify === "sql") return classifySql(sqlText ?? textOf(args[0]));
  return { isEffect: true, idempotent: entry.idempotent };
}

function objectProp(obj: Node | undefined, name: string): Node | undefined {
  if (!obj) return undefined;
  const o = unwrap(obj);
  if (!Node.isObjectLiteralExpression(o)) return undefined;
  const prop = o.getProperty(name);
  if (prop && Node.isPropertyAssignment(prop)) return prop.getInitializer();
  if (prop && Node.isShorthandPropertyAssignment(prop)) return prop.getNameNode();
  return undefined;
}

function classifyPrisma(entry: EffectCatalogEntry, args: Node[]): Classification {
  const options = args[0];
  if (entry.match.callee.endsWith("createMany")) {
    const skip = objectProp(options, "skipDuplicates");
    if (skip && skip.getText() === "true") {
      return { isEffect: true, idempotent: true, note: "skipDuplicates (relies on a unique constraint)" };
    }
    return { isEffect: true, idempotent: false };
  }
  // Updates and upserts are idempotent unless they apply a relative operation.
  const roots = [objectProp(options, "data"), objectProp(options, "update"), objectProp(options, "create")];
  for (const data of roots) {
    const d = data && unwrap(data);
    if (!d || !Node.isObjectLiteralExpression(d)) continue;
    for (const prop of d.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const value = prop.getInitializer();
      const v = value && unwrap(value);
      if (!v || !Node.isObjectLiteralExpression(v)) continue;
      const op = v.getProperties().find((p) => Node.isPropertyAssignment(p) && PRISMA_NON_IDEMPOTENT_OPS.has(p.getName()));
      if (op && Node.isPropertyAssignment(op)) {
        return { isEffect: true, idempotent: false, note: `${op.getName()} on ${prop.getName()}` };
      }
    }
  }
  return { isEffect: true, idempotent: entry.idempotent };
}

export function classifySql(sql: string | undefined): Classification {
  if (!sql) return { isEffect: true, idempotent: "unknown", note: "SQL text not statically known" };
  const s = sql.replace(/\s+/g, " ").trim().toUpperCase();
  const writes = /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(s);
  if (/^(SELECT|SHOW|EXPLAIN)\b/.test(s) || (/^WITH\b/.test(s) && !writes)) {
    return { isEffect: false, idempotent: true };
  }
  if (/\bINSERT\b/.test(s)) {
    if (/\bON CONFLICT\b[\s\S]*\bDO NOTHING\b/.test(s) || /\bINSERT IGNORE\b/.test(s)) {
      return { isEffect: true, idempotent: true, note: "conflict-ignoring insert" };
    }
    if (/\bON CONFLICT\b[\s\S]*\bDO UPDATE\b/.test(s) || /\bON DUPLICATE KEY UPDATE\b/.test(s)) {
      return hasRelativeUpdate(s)
        ? { isEffect: true, idempotent: false, note: "upsert with relative update" }
        : { isEffect: true, idempotent: true, note: "upsert" };
    }
    return { isEffect: true, idempotent: false, note: "plain INSERT" };
  }
  if (/\bUPDATE\b/.test(s)) {
    return hasRelativeUpdate(s)
      ? { isEffect: true, idempotent: false, note: "relative UPDATE" }
      : { isEffect: true, idempotent: true };
  }
  if (/\bDELETE\b/.test(s)) return { isEffect: true, idempotent: true };
  return { isEffect: true, idempotent: "unknown" };
}

function hasRelativeUpdate(upperSql: string): boolean {
  // col = col + 1, "col" = "col" - $1, col = EXCLUDED.col + t.col ...
  return /("?\w+"?)\s*=\s*(\w+\.)?\1\s*[+\-*]/.test(upperSql);
}

/** Table name targeted by an INSERT statement, if any. */
export function insertTable(sql: string | undefined): string | undefined {
  const m = sql?.match(/\binsert\s+(?:ignore\s+)?into\s+["`]?([\w.]+)["`]?/i);
  return m?.[1];
}
