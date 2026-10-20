import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import { flatten, moduleOf, resolveFunction, resolveIdentifier, textOf } from "../project/resolve";
import { pathSignals, type Candidate } from "./types";

const METHODS = new Set(["post", "put", "patch", "all"]);

function joinPath(prefix: string, p: string): string {
  return `/${`${prefix}/${p}`.split("/").filter(Boolean).join("/")}`;
}

/** The declaration a router/app identifier refers to, used to look up mount prefixes. */
function receiverDecl(receiver: Node): Node | undefined {
  if (!Node.isIdentifier(receiver)) return undefined;
  for (const r of resolveIdentifier(receiver)) if ("decl" in r) return r.decl;
  return undefined;
}

export function discoverExpress(files: SourceFile[]): Candidate[] {
  const calls = files.flatMap((sf) => sf.getDescendantsOfKind(SyntaxKind.CallExpression));
  const isExpress = (n: Node) => moduleOf(n)?.module === "express";

  // app.use("/billing", billingRouter) -> prefix for routes registered on billingRouter.
  const prefixes = new Map<Node, string>();
  for (const call of calls) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "use") continue;
    const [first, second] = call.getArguments();
    const prefix = textOf(first);
    if (prefix === undefined || !second || !isExpress(callee.getExpression())) continue;
    const decl = receiverDecl(second);
    if (decl) prefixes.set(decl, prefix);
  }

  const out: Candidate[] = [];
  for (const call of calls) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || !METHODS.has(callee.getName())) continue;
    const args = call.getArguments();
    const routePath = textOf(args[0]);
    const last = args[args.length - 1];
    if (routePath === undefined || args.length < 2 || !last) continue;
    const receiver = flatten(callee.getExpression()).root;
    if (!isExpress(receiver)) continue;
    const fn = resolveFunction(last);
    if (!fn) continue;
    const decl = receiverDecl(receiver);
    const full = joinPath((decl && prefixes.get(decl)) ?? "", routePath);
    out.push({
      kind: "http-webhook",
      framework: "express",
      name: `${callee.getName().toUpperCase()} ${full}`,
      routePath: full,
      fn,
      anchor: call,
      signals: pathSignals(full),
      alwaysAtLeastOnce: false,
    });
  }
  return out;
}
