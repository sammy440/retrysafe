import path from "node:path";
import { Node, SyntaxKind, type FileSystemHost, type SourceFile } from "ts-morph";
import { moduleOf, textOf, unwrap } from "../project/resolve";

export interface SchemaFacts {
  tables: Map<string, { name: string; unique: string[][]; source: string }>;
}

export function normalizeName(name: string): string {
  return name.replace(/["`'[\]]/g, "").split(".").pop()!.replace(/_/g, "").toLowerCase();
}

function singular(n: string): string {
  return n.endsWith("ies") ? `${n.slice(0, -3)}y` : n.endsWith("s") ? n.slice(0, -1) : n;
}

function addTable(facts: SchemaFacts, names: string[], unique: string[][], source: string): void {
  const entry = { name: names[0]!, unique: unique.map((cols) => cols.map(normalizeName)), source };
  const existing = names.map((n) => facts.tables.get(normalizeName(n))).find(Boolean);
  if (existing) {
    existing.unique.push(...entry.unique);
    for (const n of names) facts.tables.set(normalizeName(n), existing);
    return;
  }
  for (const n of names) facts.tables.set(normalizeName(n), entry);
}

export function findTable(facts: SchemaFacts, name: string) {
  const n = normalizeName(name);
  return facts.tables.get(n) ?? facts.tables.get(singular(n)) ?? facts.tables.get(`${n}s`);
}

export function parsePrismaSchema(text: string, facts: SchemaFacts, source: string): void {
  const clean = text.replace(/\/\/[^\n]*/g, "");
  for (const m of clean.matchAll(/\bmodel\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const model = m[1]!;
    const body = m[2]!;
    const unique: string[][] = [];
    let mapped: string | undefined;
    for (const line of body.split("\n").map((l) => l.trim())) {
      if (!line) continue;
      if (line.startsWith("@@")) {
        const block = line.match(/^@@(id|unique)\s*\(\s*(?:fields\s*:\s*)?\[([^\]]*)\]/);
        if (block) unique.push(block[2]!.split(",").map((f) => f.trim().split("(")[0]!).filter(Boolean));
        const map = line.match(/^@@map\(\s*"([^"]+)"/);
        if (map) mapped = map[1];
        continue;
      }
      const field = line.match(/^(\w+)\s+\S+/);
      if (field && /@(id|unique)\b/.test(line)) unique.push([field[1]!]);
    }
    const accessor = model[0]!.toLowerCase() + model.slice(1);
    addTable(facts, [model, accessor, ...(mapped ? [mapped] : [])], unique, source);
  }
}

function prismaSchemaFiles(fs: FileSystemHost, root: string): string[] {
  const candidates = [path.join(root, "prisma", "schema.prisma"), path.join(root, "schema.prisma")];
  const dir = path.join(root, "prisma", "schema");
  if (fs.directoryExistsSync(dir)) {
    for (const e of safeReadDir(fs, dir)) if (e.isFile && e.name.endsWith(".prisma")) candidates.push(path.join(dir, e.name));
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"))) as { prisma?: { schema?: string } };
    if (pkg.prisma?.schema) candidates.push(path.resolve(root, pkg.prisma.schema));
  } catch {
  }
  return candidates.filter((f) => fs.fileExistsSync(f));
}

function safeReadDir(fs: FileSystemHost, dir: string): { name: string; isFile: boolean; isDirectory: boolean }[] {
  try {
    return fs.readDirSync(dir).map((e) => ({ name: path.basename(e.name), isFile: e.isFile, isDirectory: e.isDirectory }));
  } catch {
    return [];
  }
}

function splitColumns(list: string): string[] {
  return list.split(",").map((c) => c.trim().replace(/["`]/g, "").split(/\s+/)[0]!).filter(Boolean);
}

export function parseSqlSchema(sql: string, facts: SchemaFacts, source: string): void {
  const text = sql.replace(/--[^\n]*/g, "");
  for (const m of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."`]+)\s*\(([\s\S]*?)\);/gi)) {
    const table = m[1]!.replace(/["`]/g, "");
    const unique: string[][] = [];
    let depth = 0;
    let cur = "";
    const parts: string[] = [];
    for (const ch of m[2]!) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    parts.push(cur);
    for (const p of parts.map((x) => x.trim())) {
      const constraint = p.match(/^(?:constraint\s+\S+\s+)?(primary\s+key|unique)\s*(?:key\s*)?\(([^)]*)\)/i);
      if (constraint) {
        unique.push(splitColumns(constraint[2]!));
        continue;
      }
      const col = p.match(/^["`]?(\w+)["`]?\s+/);
      if (col && /\b(primary\s+key|unique)\b/i.test(p)) unique.push([col[1]!]);
    }
    addTable(facts, [table], unique, source);
  }
  for (const m of text.matchAll(/create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?\S*\s+on\s+([\w."`]+)\s*(?:using\s+\w+\s*)?\(([^)]*)\)/gi)) {
    addTable(facts, [m[1]!.replace(/["`]/g, "")], [splitColumns(m[2]!)], source);
  }
  for (const m of text.matchAll(/alter\s+table\s+(?:only\s+)?([\w."`]+)\s+add\s+(?:constraint\s+\S+\s+)?(?:primary\s+key|unique)\s*\(([^)]*)\)/gi)) {
    addTable(facts, [m[1]!.replace(/["`]/g, "")], [splitColumns(m[2]!)], source);
  }
}

function sqlFiles(fs: FileSystemHost, root: string, limit = 2000): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 6 || out.length >= limit) return;
    for (const e of safeReadDir(fs, dir)) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "dist") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory) visit(abs, depth + 1);
      else if (e.isFile && e.name.endsWith(".sql")) out.push(abs);
    }
  };
  visit(root, 0);
  return out;
}

const DRIZZLE_TABLE = new Set(["pgTable", "mysqlTable", "sqliteTable", "table"]);

function parseDrizzle(sf: SourceFile, facts: SchemaFacts, source: string): void {
  for (const decl of sf.getVariableDeclarations()) {
    const init = decl.getInitializer() && unwrap(decl.getInitializer()!);
    if (!init || !Node.isCallExpression(init)) continue;
    const callee = init.getExpression();
    const fname = callee.getText().split(".").pop()!;
    if (!DRIZZLE_TABLE.has(fname) || !moduleOf(callee)?.module.startsWith("drizzle-orm")) continue;
    const [nameArg, columnsArg, extra] = init.getArguments();
    const sqlName = textOf(nameArg) ?? decl.getName();
    const unique: string[][] = [];
    const cols = columnsArg && unwrap(columnsArg);
    if (cols && Node.isObjectLiteralExpression(cols)) {
      for (const p of cols.getProperties()) {
        if (!Node.isPropertyAssignment(p)) continue;
        const text = p.getInitializer()?.getText() ?? "";
        if (/\.(primaryKey|unique)\(/.test(text)) {
          const sqlCol = text.match(/^\w+\(\s*["'`](\w+)["'`]/)?.[1];
          unique.push([p.getName()], ...(sqlCol ? [[sqlCol]] : []));
        }
      }
    }
    for (const m of (extra?.getText() ?? "").matchAll(/(?:unique|uniqueIndex)\([^)]*\)\s*\.on\(([^)]*)\)|primaryKey\(\s*\{\s*columns\s*:\s*\[([^\]]*)\]/g)) {
      unique.push((m[1] ?? m[2] ?? "").split(",").map((c) => c.trim().split(".").pop()!).filter(Boolean));
    }
    addTable(facts, [decl.getName(), sqlName], unique, source);
  }
}

function parseMongoose(sf: SourceFile, facts: SchemaFacts, source: string): void {
  const schemas = new Map<string, string[][]>();
  for (const n of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    if (!/(^|\.)Schema$/.test(n.getExpression().getText()) || moduleOf(n.getExpression())?.module !== "mongoose") continue;
    const unique: string[][] = [["_id"]];
    const def = n.getArguments()[0] && unwrap(n.getArguments()[0]!);
    if (def && Node.isObjectLiteralExpression(def)) {
      for (const p of def.getProperties()) {
        if (Node.isPropertyAssignment(p) && /unique\s*:\s*true/.test(p.getInitializer()?.getText() ?? "")) unique.push([p.getName()]);
      }
    }
    const holder = n.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    schemas.set(holder?.getName() ?? `@${n.getStart()}`, unique);
    const call = n.getParentIfKind(SyntaxKind.CallExpression);
    const modelName = call && /(^|\.)model$/.test(call.getExpression().getText()) ? textOf(call.getArguments()[0]) : undefined;
    if (modelName) addTable(facts, [modelName, call!.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getName() ?? modelName], unique, source);
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!/(^|\.)model$/.test(call.getExpression().getText())) continue;
    const [nameArg, schemaArg] = call.getArguments();
    const unique = schemaArg && schemas.get(schemaArg.getText());
    const name = textOf(nameArg);
    if (name && unique) addTable(facts, [name, call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getName() ?? name], unique, source);
  }
}

export function loadSchema(fs: FileSystemHost, root: string, sourceFiles: SourceFile[]): SchemaFacts {
  const facts: SchemaFacts = { tables: new Map() };
  const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
  for (const f of prismaSchemaFiles(fs, root)) parsePrismaSchema(fs.readFileSync(f), facts, rel(f));
  for (const f of sqlFiles(fs, root)) parseSqlSchema(fs.readFileSync(f), facts, rel(f));
  for (const sf of sourceFiles) {
    const text = sf.getFullText();
    if (text.includes("drizzle-orm")) parseDrizzle(sf, facts, rel(sf.getFilePath()));
    if (text.includes("mongoose")) parseMongoose(sf, facts, rel(sf.getFilePath()));
  }
  return facts;
}

export function insertProtection(facts: SchemaFacts, table: string | undefined, columns: string[] | undefined): "unique-constraint" | "no-unique-constraint" | "not-found" {
  if (!table) return "not-found";
  const t = findTable(facts, table);
  if (!t) return "not-found";
  if (!columns) return t.unique.length ? "unique-constraint" : "no-unique-constraint";
  const inserted = new Set(columns.map(normalizeName));
  return t.unique.some((set) => set.length > 0 && set.every((c) => inserted.has(c))) ? "unique-constraint" : "no-unique-constraint";
}
