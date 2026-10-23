import { Node } from "ts-morph";
import { textOf, unwrap } from "../project/resolve";
import type { EffectKind, KeySpec } from "../types";
import { HTTP_HOSTS, type EffectCatalogEntry } from "./catalog";

export interface Classification {
  isEffect: boolean;
  idempotent: boolean | "unknown";
  note?: string;
  kind?: EffectKind;
  acceptsKey?: KeySpec;
  keyNode?: Node;
}

const PRISMA_NON_IDEMPOTENT_OPS = new Set(["increment", "decrement", "multiply", "divide", "push"]);

export function classify(entry: EffectCatalogEntry, args: Node[], sqlText: string | undefined, chain: string[]): Classification {
  if (entry.classify === "prisma-write") return classifyPrisma(entry, args);
  if (entry.classify === "sql") return classifySql(sqlText ?? textOf(args[0]));
  if (entry.classify === "graphql") return classifyGraphql(sqlText ?? textOf(args[0]));
  if (entry.classify === "http") return classifyHttp(args, chain);
  return { isEffect: true, idempotent: entry.idempotent };
}

export function classifyGraphql(doc: string | undefined): Classification {
  if (!doc) return { isEffect: true, idempotent: "unknown", note: "GraphQL document not statically known" };
  if (!/^\s*mutation\b/.test(doc.replace(/#[^\n]*/g, ""))) return { isEffect: false, idempotent: true };
  const name = doc.match(/\{\s*(\w+)/)?.[1];
  if (/@idempotent\s*\(/.test(doc)) return { isEffect: true, idempotent: true, note: `${name ?? "mutation"} with @idempotent` };
  return { isEffect: true, idempotent: false, note: name ? `mutation ${name}` : "mutation" };
}

const HTTP_WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);

function findProperty(args: Node[], name: string): Node | undefined {
  const want = name.toLowerCase();
  for (const a of args) {
    for (const p of [a, ...a.getDescendants()]) {
      if (!Node.isPropertyAssignment(p)) continue;
      if (p.getName().replace(/^["'`]|["'`]$/g, "").toLowerCase() === want) return p.getInitializer();
    }
  }
  return undefined;
}

export function classifyHttp(args: Node[], chain: string[]): Classification {
  const last = chain[chain.length - 1];
  let method = last && HTTP_WRITE_METHODS.has(last) ? last : undefined;
  let urlNode: Node | undefined = args[0];
  let options = args.slice(1);
  const first = args[0] && unwrap(args[0]);
  if (first && Node.isObjectLiteralExpression(first)) {
    const url = first.getProperty("url");
    urlNode = url && Node.isPropertyAssignment(url) ? url.getInitializer() : undefined;
    options = [first];
  }
  if (!method) {
    const m = findProperty(options, "method");
    method = m ? textOf(m)?.toLowerCase() : undefined;
  }
  if (!method || !HTTP_WRITE_METHODS.has(method)) return { isEffect: false, idempotent: true };

  const url = (urlNode && (textOf(urlNode) ?? urlNode.getText())) ?? "";
  const host = Object.keys(HTTP_HOSTS).find((h) => url.includes(h));
  const fact = host ? HTTP_HOSTS[host] : undefined;
  const label = `${method.toUpperCase()} ${host ?? (url.length > 40 ? `${url.slice(0, 40)}…` : url || "(dynamic URL)")}`;
  if (!fact) {
    return { isEffect: true, idempotent: method === "delete" || method === "put" ? true : "unknown", note: label };
  }
  const keyField = fact.idempotencyHeader ?? fact.bodyKey;
  const keyNode = keyField ? findProperty(options.length ? options : args, keyField) : undefined;
  return {
    isEffect: true,
    kind: fact.kind,
    idempotent: method === "delete",
    note: label,
    acceptsKey: keyField ? { arg: Math.max(1, args.indexOf(options[options.length - 1] ?? args[1]!)), field: keyField } : undefined,
    keyNode,
  };
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
  return /("?\w+"?)\s*=\s*(\w+\.)?\1\s*[+\-*]/.test(upperSql);
}

export function insertTable(sql: string | undefined): string | undefined {
  const m = sql?.match(/\binsert\s+(?:ignore\s+)?into\s+["`]?([\w.]+)["`]?/i);
  return m?.[1];
}
