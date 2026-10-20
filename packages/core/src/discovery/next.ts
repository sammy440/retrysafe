import path from "node:path";
import type { SourceFile } from "ts-morph";
import { functionFromDeclaration } from "../project/resolve";
import { pathSignals, type Candidate } from "./types";

const APP_ROUTE = /(?:^|\/)(?:src\/)?app\/(.*?)\/?route\.[cm]?[jt]sx?$/;
const PAGES_API = /(?:^|\/)(?:src\/)?pages\/(api\/.+)\.[cm]?[jt]sx?$/;
const METHODS = ["POST", "PUT", "PATCH"];

function routeFromSegments(rel: string): string {
  // Drop route groups "(marketing)" and parallel-route slots "@modal".
  const segs = rel.split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
  if (segs[segs.length - 1] === "index") segs.pop();
  return `/${segs.join("/")}`;
}

export function discoverNext(files: SourceFile[], root: string): Candidate[] {
  const out: Candidate[] = [];
  for (const sf of files) {
    const rel = path.relative(root, sf.getFilePath()).split(path.sep).join("/");
    const app = rel.match(APP_ROUTE);
    if (app) {
      const routePath = routeFromSegments(app[1] ?? "");
      const exported = sf.getExportedDeclarations();
      for (const method of METHODS) {
        for (const decl of exported.get(method) ?? []) {
          const fn = functionFromDeclaration(decl);
          if (!fn) continue;
          out.push({
            kind: "http-webhook",
            framework: "next-app-router",
            name: `${method} ${routePath}`,
            routePath,
            fn,
            anchor: fn,
            signals: pathSignals(routePath),
            alwaysAtLeastOnce: false,
          });
        }
      }
      continue;
    }
    const pages = rel.match(PAGES_API);
    if (pages) {
      const routePath = routeFromSegments(pages[1] ?? "");
      for (const decl of sf.getExportedDeclarations().get("default") ?? []) {
        const fn = functionFromDeclaration(decl);
        if (!fn) continue;
        out.push({
          kind: "http-webhook",
          framework: "next-pages-api",
          name: `ANY ${routePath}`,
          routePath,
          fn,
          anchor: fn,
          signals: pathSignals(routePath),
          alwaysAtLeastOnce: false,
        });
      }
    }
  }
  return out;
}
