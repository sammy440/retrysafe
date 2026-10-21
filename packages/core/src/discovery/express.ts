import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import { flatten, moduleOf, resolveHandler, resolveIdentifier, textOf, unwrap } from "../project/resolve";
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

  // app.use(mw) / router.use("/path", mw): middleware for later routes on the same app or router.
  const uses: { decl: Node; path: string; nodes: Node[]; pos: number; file: string }[] = [];
  for (const call of calls) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "use") continue;
    const receiver = flatten(callee.getExpression()).root;
    if (!isExpress(receiver)) continue;
    const decl = receiverDecl(receiver);
    if (!decl) continue;
    const args = call.getArguments();
    const path = textOf(args[0]);
    // Routers mounted with use() are not middleware.
    const nodes = (path === undefined ? args : args.slice(1)).filter((a) => !(Node.isIdentifier(a) && prefixes.has(receiverDecl(a) ?? a)));
    uses.push({ decl, path: path ?? "/", nodes, pos: call.getStart(), file: call.getSourceFile().getFilePath() });
  }

  const out: Candidate[] = [];
  for (const call of calls) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || !METHODS.has(callee.getName())) continue;
    const args = call.getArguments();
    // router.route("/hooks").post(handler) carries the path on the route() call.
    const inner = unwrap(callee.getExpression());
    const chained = Node.isCallExpression(inner) && Node.isPropertyAccessExpression(inner.getExpression()) && inner.getExpression().getText().endsWith(".route");
    const routePath = chained ? textOf(inner.getArguments()[0]) : textOf(args[0]);
    const last = args[args.length - 1];
    if (routePath === undefined || args.length < (chained ? 1 : 2) || !last) continue;
    const receiver = flatten(chained ? (inner.getExpression() as import("ts-morph").PropertyAccessExpression).getExpression() : callee.getExpression()).root;
    if (!isExpress(receiver)) continue;
    const fn = resolveHandler(last);
    if (!fn) continue;
    const decl = receiverDecl(receiver);
    const full = joinPath((decl && prefixes.get(decl)) ?? "", routePath);
    const routeMiddleware = chained ? args.slice(0, -1) : args.slice(1, -1);
    const appMiddleware = uses
      .filter((u) => u.decl === decl && u.file === call.getSourceFile().getFilePath() && u.pos < call.getStart() && joinPath("", routePath).startsWith(joinPath("", u.path)))
      .flatMap((u) => u.nodes);
    out.push({
      kind: "http-webhook",
      framework: "express",
      name: `${callee.getName().toUpperCase()} ${full}`,
      routePath: full,
      fn,
      anchor: call,
      signals: pathSignals(full),
      alwaysAtLeastOnce: false,
      middleware: [...appMiddleware, ...routeMiddleware],
    });
  }
  return out;
}
