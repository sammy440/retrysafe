import path from "node:path";
import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import { functionFromDeclaration, isFunctionLike, type FunctionLike } from "../project/resolve";
import type { Candidate } from "./types";

function hasUseServer(statements: Node[]): boolean {
  for (const s of statements) {
    if (!Node.isExpressionStatement(s)) return false;
    const e = s.getExpression();
    if (!Node.isStringLiteral(e)) return false;
    if (e.getLiteralValue() === "use server") return true;
  }
  return false;
}

export function discoverServerActions(files: SourceFile[], root: string): Candidate[] {
  const out: Candidate[] = [];
  const push = (fn: FunctionLike, rel: string, name: string) =>
    out.push({ kind: "server-action", framework: "next-server-action", name: `Server action ${rel}#${name}`, fn, anchor: fn, signals: ["server-action"], alwaysAtLeastOnce: true });

  for (const sf of files) {
    const rel = path.relative(root, sf.getFilePath()).split(path.sep).join("/");
    if (hasUseServer(sf.getStatements())) {
      for (const [name, decls] of sf.getExportedDeclarations()) {
        const fn = decls[0] && functionFromDeclaration(decls[0]);
        if (fn) push(fn, rel, name);
      }
      continue;
    }
    for (const node of sf.getDescendants()) {
      if (!isFunctionLike(node)) continue;
      const body = node.getBody();
      if (body && Node.isBlock(body) && hasUseServer(body.getStatements())) {
        const name = (node as { getName?: () => string | undefined }).getName?.() ?? node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getName() ?? `L${node.getStartLineNumber()}`;
        push(node, rel, name);
      }
    }
  }
  return out;
}
