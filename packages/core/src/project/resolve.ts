import { Node, SyntaxKind, type Expression, type SourceFile } from "ts-morph";

export type FunctionLike = Node & {
  getBody(): Node | undefined;
};

export type CallTarget =
  | {
      kind: "external";
      module: string;
      chain: string[];
      viaTransaction: boolean;
    }
  | { kind: "local"; fn: FunctionLike; name: string }
  | { kind: "unresolved"; name: string };

export type CallLike = Node & { getKind(): SyntaxKind };

const TRANSACTION_METHODS = new Set(["$transaction", "transaction"]);
const GLOBAL_MODULES = new Set(["fetch"]);

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
    return typeModule(decl.getTypeNode());
  }
  if (Node.isPropertyDeclaration(decl) || Node.isPropertyAssignment(decl)) {
    const init = decl.getInitializer();
    return init ? moduleOf(init, seen) : undefined;
  }
  return undefined;
}

export function resolveHandler(expr: Node | undefined): FunctionLike | undefined {
  if (!expr) return undefined;
  const direct = resolveFunction(expr);
  if (direct) return direct;
  const n = unwrap(expr);
  if (Node.isCallExpression(n)) {
    const args = n.getArguments();
    for (let i = args.length - 1; i >= 0; i--) {
      const fn = resolveHandler(args[i]);
      if (fn) return fn;
    }
  }
  return undefined;
}

export function handlerFromDeclaration(decl: Node): FunctionLike | undefined {
  const fn = functionFromDeclaration(decl);
  if (fn) return fn;
  if (Node.isVariableDeclaration(decl)) return resolveHandler(decl.getInitializer());
  if (Node.isExportAssignment(decl)) return resolveHandler(decl.getExpression());
  return undefined;
}

export function typeModule(typeNode: Node | undefined): { module: string; viaTransaction: boolean } | undefined {
  if (!typeNode || !Node.isTypeReference(typeNode)) return undefined;
  let name: Node = typeNode.getTypeName();
  while (Node.isQualifiedName(name)) name = name.getLeft();
  for (const r of resolveIdentifier(name)) {
    if ("module" in r) return { module: r.module, viaTransaction: /Transaction/.test(typeNode.getText()) };
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
  const assignment = Node.isBinaryExpression(decl) ? decl : decl.getParent();
  if (assignment && Node.isBinaryExpression(assignment) && assignment.getOperatorToken().getText() === "=") {
    const right = unwrap(assignment.getRight());
    if (isFunctionLike(right)) return right;
  }
  if (Node.isExportAssignment(decl)) {
    const u = unwrap(decl.getExpression());
    if (isFunctionLike(u)) return u;
    if (Node.isIdentifier(u)) return resolveFunction(u);
  }
  return undefined;
}

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

  if (chain.length === 0) {
    const fn = resolveFunction(root);
    if (fn) return { kind: "local", fn, name };
  } else {
    const fn = resolveFunction(callee);
    if (fn) return { kind: "local", fn, name };
  }

  const m = moduleOf(root);
  if (m) return { kind: "external", module: m.module, chain, viaTransaction: m.viaTransaction };
  if (Node.isIdentifier(root) && GLOBAL_MODULES.has(root.getText())) {
    const decls = root.getSymbol()?.getDeclarations() ?? [];
    if (decls.every((d) => d.getSourceFile().isDeclarationFile())) return { kind: "external", module: `global:${root.getText()}`, chain, viaTransaction: false };
  }
  return { kind: "unresolved", name };
}

export function textOf(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  const n = unwrap(node);
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralValue();
  if (Node.isTemplateExpression(n)) return n.getText().slice(1, -1);
  if (Node.isTaggedTemplateExpression(n)) return n.getTemplate().getText().slice(1, -1);
  if (Node.isIdentifier(n)) {
    for (const r of resolveIdentifier(n)) {
      if ("decl" in r && Node.isVariableDeclaration(r.decl)) return textOf(r.decl.getInitializer());
    }
  }
  return undefined;
}
