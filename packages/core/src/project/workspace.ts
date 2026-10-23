import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";

export function workspacePatterns(root: string): string[] {
  const patterns: string[] = [];
  const pkgPath = path.join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const ws = (JSON.parse(readFileSync(pkgPath, "utf8")) as { workspaces?: string[] | { packages?: string[] } }).workspaces;
      patterns.push(...(Array.isArray(ws) ? ws : (ws?.packages ?? [])));
    } catch {
    }
  }
  const pnpmPath = path.join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpmPath)) {
    let inPackages = false;
    for (const line of readFileSync(pnpmPath, "utf8").split("\n")) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/.test(line)) inPackages = false;
      const m = inPackages && line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
      if (m) patterns.push(m[1]!.trim());
    }
  }
  return patterns;
}

export function workspacePackages(root: string, maxDepth = 4): string[] {
  const patterns = workspacePatterns(root).map((p) => p.replace(/\/+$/, ""));
  if (!patterns.length) return [];
  const include = picomatch(patterns.filter((p) => !p.startsWith("!")));
  const exclude = picomatch(patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1)));
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (include(rel) && !exclude(rel) && existsSync(path.join(abs, "package.json"))) out.push(abs);
      visit(abs, depth + 1);
    }
  };
  visit(root, 1);
  return out;
}

export function tsconfigReferences(tsconfigPath: string): string[] {
  try {
    const text = readFileSync(tsconfigPath, "utf8")
      .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? "")
      .replace(/,(\s*[}\]])/g, "$1");
    const refs = (JSON.parse(text) as { references?: { path: string }[] }).references ?? [];
    return refs.map((r) => {
      const p = path.resolve(path.dirname(tsconfigPath), r.path);
      return p.endsWith(".json") ? p : path.join(p, "tsconfig.json");
    });
  } catch {
    return [];
  }
}
