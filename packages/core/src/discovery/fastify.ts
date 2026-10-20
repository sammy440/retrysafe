import { Node, SyntaxKind, type ObjectLiteralExpression, type SourceFile } from "ts-morph";
import { flatten, isFunctionLike, moduleOf, resolveFunction, textOf, unwrap, type FunctionLike } from "../project/resolve";
import { pathSignals, type Candidate } from "./types";

const METHODS = new Set(["post", "put", "patch", "all"]);

function joinPath(...parts: string[]): string {
  return `/${parts.join("/").split("/").filter(Boolean).join("/")}`;
}

function prop(obj: ObjectLiteralExpression, name: string): Node | undefined {
  const p = obj.getProperty(name);
  if (p && Node.isPropertyAssignment(p)) return p.getInitializer();
  if (p && (Node.isShorthandPropertyAssignment(p) || Node.isMethodDeclaration(p))) return Node.isMethodDeclaration(p) ? p : p.getNameNode();
  return undefined;
}

/** The plugin function a route is registered inside, if its first parameter is the receiver. */
function enclosingPlugin(receiver: Node): FunctionLike | undefined {
  if (!Node.isIdentifier(receiver)) return undefined;
  const decl = receiver.getSymbol()?.getDeclarations()[0];
  if (!decl || !Node.isParameterDeclaration(decl)) return undefined;
  const fn = decl.getParent();
  return isFunctionLike(fn) ? fn : undefined;
}

/**
 * Fastify: `app.post(url, [opts], handler)`, `app.route({ method, url, handler })`, routes registered inside
 * plugins, and `app.register(plugin, { prefix })` prefixes (one level).
 */
export function discoverFastify(files: SourceFile[]): Candidate[] {
  const calls = files.flatMap((sf) => sf.getDescendantsOfKind(SyntaxKind.CallExpression));
  const isFastify = (n: Node) => moduleOf(n)?.module === "fastify";

  // Plugins passed to register() take a Fastify instance as their first parameter, typed or not.
  const prefixes = new Map<Node, string>();
  const plugins = new Set<Node>();
  for (const call of calls) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "register") continue;
    const [plugin, opts] = call.getArguments();
    const fn = plugin && resolveFunction(plugin);
    if (!fn || !isFastify(flatten(callee.getExpression()).root)) continue;
    plugins.add(fn);
    const o = opts && unwrap(opts);
    const prefix = o && Node.isObjectLiteralExpression(o) ? textOf(prop(o, "prefix")) : undefined;
    if (prefix !== undefined) prefixes.set(fn, prefix);
  }

  const out: Candidate[] = [];
  const hooks = (opts: Node | undefined): Node[] => {
    const o = opts && unwrap(opts);
    if (!o || !Node.isObjectLiteralExpression(o)) return [];
    return ["onRequest", "preParsing", "preValidation", "preHandler"].flatMap((h) => prop(o, h) ?? []);
  };
  const push = (call: Node, method: string, url: string, handlerNode: Node | undefined, receiver: Node, middleware: Node[] = []) => {
    const fn = handlerNode && resolveFunction(handlerNode);
    if (!fn) return;
    const plugin = enclosingPlugin(receiver);
    const full = joinPath((plugin && prefixes.get(plugin)) ?? "", url);
    out.push({
      kind: "http-webhook",
      framework: "fastify",
      name: `${method.toUpperCase()} ${full}`,
      routePath: full,
      fn,
      anchor: call,
      signals: pathSignals(full),
      alwaysAtLeastOnce: false,
      middleware,
    });
  };

  for (const call of calls) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const receiver = flatten(callee.getExpression()).root;
    const name = callee.getName();
    if (!METHODS.has(name) && name !== "route") continue;
    const plugin = enclosingPlugin(receiver);
    if (!isFastify(receiver) && !(plugin && plugins.has(plugin))) continue;
    const args = call.getArguments();

    if (name === "route") {
      const o = args[0] && unwrap(args[0]);
      if (!o || !Node.isObjectLiteralExpression(o)) continue;
      const methodNode = prop(o, "method");
      const methods = methodNode && Node.isArrayLiteralExpression(unwrap(methodNode))
        ? (unwrap(methodNode) as import("ts-morph").ArrayLiteralExpression).getElements().map((e) => textOf(e) ?? "")
        : [textOf(methodNode) ?? ""];
      const url = textOf(prop(o, "url") ?? prop(o, "path"));
      if (url === undefined) continue;
      for (const m of methods) if (METHODS.has(m.toLowerCase())) push(call, m, url, prop(o, "handler"), receiver, hooks(o));
      continue;
    }

    const url = textOf(args[0]);
    if (url === undefined || args.length < 2) continue;
    const last = unwrap(args[args.length - 1]!);
    // app.post(url, { handler }) or app.post(url, opts, handler)
    const handler = Node.isObjectLiteralExpression(last) ? prop(last, "handler") : last;
    push(call, name, url, handler, receiver, hooks(args.length > 2 ? args[1] : Node.isObjectLiteralExpression(last) ? last : undefined));
  }
  return out;
}
