import { Node } from "ts-morph";
import { calleeOf, flatten, moduleOf, resolveIdentifier, unwrap } from "../project/resolve";
import type { KeySource, SourceLocation } from "../types";

/** Calls that return a different value on every run. Matched against `module:chain` or global callee text. */
const NONDETERMINISTIC_GLOBALS = new Set(["Date.now", "Math.random", "crypto.randomUUID", "performance.now", "process.hrtime"]);
const NONDETERMINISTIC_MODULE_CALLS: Record<string, Set<string>> = {
  uuid: new Set(["v1", "v4", "v6", "v7", "uuid", "default"]),
  crypto: new Set(["randomUUID", "randomBytes", "randomInt"]),
  nanoid: new Set(["nanoid", "default"]),
  cuid: new Set(["default", "cuid"]),
  "@paralleldrive/cuid2": new Set(["createId"]),
  ulid: new Set(["ulid", "monotonicFactory"]),
};

function nondeterministicCall(node: Node): string | undefined {
  if (Node.isNewExpression(node)) {
    // new Date() with no arguments is "now"; new Date(event.created) is not.
    return node.getExpression().getText() === "Date" && (node.getArguments() ?? []).length === 0 ? "new Date()" : undefined;
  }
  if (!Node.isCallExpression(node)) return undefined;
  const callee = calleeOf(node);
  const text = callee.getText().replace(/\s+/g, "");
  if (NONDETERMINISTIC_GLOBALS.has(text)) return `${text}()`;
  const { root, chain } = flatten(callee);
  const m = moduleOf(root);
  if (m) {
    const calls = NONDETERMINISTIC_MODULE_CALLS[m.module];
    // `import { v4 } from "uuid"` has an empty chain; use the imported name.
    const name = chain[chain.length - 1] ?? importedName(root) ?? "default";
    if (calls?.has(name)) return `${text}()`;
  }
  // new Date().getTime() / .toISOString() / .valueOf()
  const recv = unwrap(Node.isPropertyAccessExpression(callee) ? callee.getExpression() : callee);
  if (Node.isPropertyAccessExpression(callee) && Node.isNewExpression(recv) && nondeterministicCall(recv)) return `${text}()`;
  return undefined;
}

function importedName(id: Node): string | undefined {
  if (!Node.isIdentifier(id)) return undefined;
  for (const d of id.getSymbol()?.getDeclarations() ?? []) {
    if (Node.isImportSpecifier(d)) return d.getName(); // imported name, even when aliased
    if (Node.isImportClause(d)) return "default";
  }
  return undefined;
}

/**
 * Trace where a key value comes from: event/job fields, constants, parameters, or values that differ
 * on every run (Date.now(), uuid(), ...). Follows local variables and template/concatenation parts.
 */
export function traceKey(node: Node | undefined, loc: (n: Node) => SourceLocation, depth = 0, seen = new Set<Node>()): KeySource[] {
  if (!node || depth > 8 || seen.has(node)) return [];
  seen.add(node);
  const n = unwrap(node);
  const here = (kind: KeySource["kind"]): KeySource[] => [{ kind, text: n.getText(), location: loc(n) }];
  const next = (c: Node | undefined) => traceKey(c, loc, depth + 1, seen);

  const nd = nondeterministicCall(n);
  if (nd) return [{ kind: "nondeterministic", text: nd, location: loc(n) }];

  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n) || Node.isNumericLiteral(n)) return here("constant");
  if (Node.isTemplateExpression(n)) return n.getTemplateSpans().flatMap((s) => next(s.getExpression()));
  if (Node.isBinaryExpression(n)) return [...next(n.getLeft()), ...next(n.getRight())];
  if (Node.isConditionalExpression(n)) return [...next(n.getWhenTrue()), ...next(n.getWhenFalse())];
  if (Node.isArrayLiteralExpression(n)) return n.getElements().flatMap((e) => next(e));
  if (Node.isObjectLiteralExpression(n)) {
    return n.getProperties().flatMap((p) => (Node.isPropertyAssignment(p) ? next(p.getInitializer()) : Node.isShorthandPropertyAssignment(p) ? next(p.getNameNode()) : []));
  }
  if (Node.isPropertyAccessExpression(n) || Node.isElementAccessExpression(n)) return here("event-field");
  if (Node.isCallExpression(n)) {
    // String(x), x.toString(), hash(x), JSON.stringify(x): the key comes from the inputs.
    const callee = calleeOf(n);
    const recv = Node.isPropertyAccessExpression(callee) ? next(callee.getExpression()) : [];
    const args = n.getArguments().flatMap((a) => next(a));
    return recv.length || args.length ? [...recv, ...args] : here("unknown");
  }
  if (Node.isIdentifier(n)) {
    for (const r of resolveIdentifier(n)) {
      if (!("decl" in r)) continue;
      if (Node.isVariableDeclaration(r.decl)) {
        const init = r.decl.getInitializer();
        return init ? next(init) : here("unknown");
      }
      if (Node.isParameterDeclaration(r.decl) || Node.isBindingElement(r.decl)) return here("param");
    }
    return here("unknown");
  }
  return here("unknown");
}
