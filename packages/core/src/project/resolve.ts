import { Node, SyntaxKind, type Expression, type SourceFile } from "ts-morph";

export type FunctionLike = Node & {
  getBody(): Node | undefined;
};

export type CallTarget =
  | {
      kind: "external";
      module: string;
      /** Member chain after the resolved receiver, e.g. ["order", "create"] for prisma.order.create. */
      chain: string[];
      /** True when the receiver is a callback parameter of a transaction call (prisma.$transaction(tx => ...)). */
      viaTransaction: boolean;
    }
  | { kind: "local"; fn: FunctionLike; name: string }
  | { kind: "unresolved"; name: string };

/** Call-like node: a regular call or a tagged template (prisma.$executeRaw`...`). */
export type CallLike = Node & { getKind(): SyntaxKind };

const TRANSACTION_METHODS = new Set(["$transaction", "transaction"]);

export function isFunctionLike(node: Node | undefined): node is FunctionLike {
  return (
    !!node &&
    (Node.isFunctionDeclaration(node) ||
      Node.isFunctionExpression(node) ||
      Node.isArrowFunction(node) ||
      Node.isMethodDeclaration(node))
  );
}

export function unwrap(node: Node): Node {
  let n = node;
  while (
    Node.isAwaitExpression(n) ||
    Node.isParenthesizedExpression(n) ||
    Node.isNonNullExpression(n) ||
    Node.isAsExpression(n) ||
    Node.isTypeAssertion(n) ||
    Node.isSatisfiesExpression(n)
  ) {
    n = n.getExpression();
  }
  return n;
}

/** Split `a.b.c` into root `a` and chain ["b", "c"]. Stops at anything that is not a property access. */
export function flatten(expr: Node): { root: Node; chain: string[] } {
  const chain: string[] = [];
  let n = unwrap(expr);
  while (Node.isPropertyAccessExpression(n)) {
    chain.unshift(n.getName());
    n = unwrap(n.getExpression());
  }
  return { root: n, chain };
}

function normalizeModule(spec: string): string {
  return spec.startsWith("node:") ? spec.slice(5) : spec;
}

function isProjectFile(sf: SourceFile | undefined): sf is SourceFile {
  return !!sf && !sf.isDeclarationFile() && !sf.isInNodeModules();
}

type Resolved = { decl: Node } | { module: string };

/**
 * Resolve an identifier to its declarations, following imports into project files.
 * Imports of packages (or files outside the project) resolve to `{ module }`.
 */
export function resolveIdentifier(id: Node): Resolved[] {
  const symbol = id.getSymbol();
  if (!symbol) return [];
  const out: Resolved[] = [];
  for (const decl of symbol.getDeclarations()) {
    const importDecl = decl.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) ?? (Node.isImportDeclaration(decl) ? decl : undefined);
    if (importDecl) {
      const target = importDecl.getModuleSpecifierSourceFile();
      if (isProjectFile(target)) {
        const aliased = symbol.getAliasedSymbol();
        for (const d of aliased?.getDeclarations() ?? []) out.push({ decl: d });
      } else {
        out.push({ module: normalizeModule(importDecl.getModuleSpecifierValue()) });
      }
      continue;
    }
    if (Node.isImportEqualsDeclaration(decl)) {
      const ref = decl.getModuleReference();
      if (Node.isExternalModuleReference(ref)) {
        const spec = ref.getExpression();
        if (spec && Node.isStringLiteral(spec)) out.push({ module: normalizeModule(spec.getLiteralValue()) });
      }
      continue;
    }
    out.push({ decl });
  }
  return out;
}

/**
 * Which external module does this expression's value come from, if any?
 * `new Stripe(...)`, `nodemailer.createTransport()`, `express.Router()`, `require("pg")`, and
 * variables or imports initialized with those, all resolve to their package name.
 */
export function moduleOf(expr: Node, seen = new Set<Node>()): { module: string; viaTransaction: boolean } | undefined {
  const n = unwrap(expr);
  if (seen.has(n)) return undefined;
  seen.add(n);

  if (Node.isCallExpression(n)) {
    const callee = unwrap(n.getExpression());
    if (Node.isIdentifier(callee) && callee.getText() === "require") {
      const arg = n.getArguments()[0];
      if (arg && Node.isStringLiteral(arg)) return { module: normalizeModule(arg.getLiteralValue()), viaTransaction: false };
    }
    return moduleOf(callee, seen);
  }
  if (Node.isNewExpression(n)) return moduleOf(n.getExpression(), seen);
  if (Node.isPropertyAccessExpression(n)) return moduleOf(flatten(n).root, seen);
  if (Node.isBinaryExpression(n)) return moduleOf(n.getLeft(), seen) ?? moduleOf(n.getRight(), seen);
  if (Node.isConditionalExpression(n)) return moduleOf(n.getWhenTrue(), seen) ?? moduleOf(n.getWhenFalse(), seen);
  if (Node.isIdentifier(n)) {
    for (const r of resolveIdentifier(n)) {
      if ("module" in r) return { module: r.module, viaTransaction: false };
      const m = moduleOfDeclaration(r.decl, seen);
      if (m) return m;
    }
  }
  return undefined;
}

function moduleOfDeclaration(decl: Node, seen: Set<Node>): { module: string; viaTransaction: boolean } | undefined {
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    return init ? moduleOf(init, seen) : undefined;
  }
  if (Node.isBindingElement(decl)) {
    const varDecl = decl.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    return varDecl ? moduleOfDeclaration(varDecl, seen) : undefined;
  }
  if (Node.isParameterDeclaration(decl)) {
    // A callback parameter takes the module of the call it is passed to:
    // (req, res) in app.post(...) -> express; tx in prisma.$transaction(async (tx) => ...) -> @prisma/client.
    const fn = decl.getParent();
    const call = fn?.getParent();
    if (fn && call && Node.isCallExpression(call) && call.getArguments().includes(fn as Expression)) {
      const outer = moduleOf(call.getExpression(), seen);
      if (outer) {
        const { chain } = flatten(call.getExpression());
        const last = chain[chain.length - 1];
        return { module: outer.module, viaTransaction: !!last && TRANSACTION_METHODS.has(last) };
      }
    }
    return undefined;
  }
  if (Node.isPropertyDeclaration(decl) || Node.isPropertyAssignment(decl)) {
    const init = decl.getInitializer();
    return init ? moduleOf(init, seen) : undefined;
  }
  return undefined;
}

export function functionFromDeclaration(decl: Node): FunctionLike | undefined {
  if (isFunctionLike(decl)) return decl;
  if (Node.isVariableDeclaration(decl) || Node.isPropertyAssignment(decl) || Node.isPropertyDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init) {
      const u = unwrap(init);
      if (isFunctionLike(u)) return u;
    }
  }
  if (Node.isExportAssignment(decl)) {
    const u = unwrap(decl.getExpression());
    if (isFunctionLike(u)) return u;
    if (Node.isIdentifier(u)) return resolveFunction(u);
  }
  return undefined;
}

/** Resolve an identifier or expression that names a function in the project. */
export function resolveFunction(expr: Node): FunctionLike | undefined {
  const n = unwrap(expr);
  if (isFunctionLike(n)) return n;
  if (Node.isIdentifier(n)) {
    for (const r of resolveIdentifier(n)) {
      if ("decl" in r) {
        const fn = functionFromDeclaration(r.decl);
        if (fn) return fn;
      }
    }
  }
  if (Node.isPropertyAccessExpression(n)) {
    const sym = n.getNameNode().getSymbol();
    for (const d of sym?.getDeclarations() ?? []) {
      if (d.getSourceFile().isDeclarationFile() || d.getSourceFile().isInNodeModules()) continue;
      const fn = functionFromDeclaration(d);
      if (fn) return fn;
    }
  }
  return undefined;
}

export function calleeOf(call: CallLike): Node {
  if (Node.isCallExpression(call)) return call.getExpression();
  if (Node.isTaggedTemplateExpression(call)) return call.getTag();
  throw new Error(`not a call: ${call.getKindName()}`);
}

export function resolveCall(call: CallLike): CallTarget {
  const callee = calleeOf(call);
  const name = callee.getText().replace(/\s+/g, "");
  const { root, chain } = flatten(callee);

  // Own code first: a property access whose member resolves to a project function (object/class/namespace import).
  if (chain.length === 0) {
    const fn = resolveFunction(root);
    if (fn) return { kind: "local", fn, name };
  } else {
    const fn = resolveFunction(callee);
    if (fn) return { kind: "local", fn, name };
  }

  const m = moduleOf(root);
  if (m) return { kind: "external", module: m.module, chain, viaTransaction: m.viaTransaction };
  return { kind: "unresolved", name };
}

/** Extract literal text from a string, template, or a const initialized with one. */
export function textOf(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  const n = unwrap(node);
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralValue();
  if (Node.isTemplateExpression(n)) return n.getText().slice(1, -1);
  if (Node.isIdentifier(n)) {
    for (const r of resolveIdentifier(n)) {
      if ("decl" in r && Node.isVariableDeclaration(r.decl)) return textOf(r.decl.getInitializer());
    }
  }
  return undefined;
}
