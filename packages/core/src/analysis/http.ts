import { Node, SyntaxKind } from "ts-morph";
import { flatten, moduleOf, resolveIdentifier, unwrap } from "../project/resolve";

/** Evaluate a numeric expression: literals, + - * /, parentheses, and `const` identifiers. */
export function evalNumber(node: Node | undefined, depth = 0): number | undefined {
  if (!node || depth > 6) return undefined;
  const n = unwrap(node);
  if (Node.isNumericLiteral(n)) return n.getLiteralValue();
  if (Node.isPrefixUnaryExpression(n) && n.getOperatorToken() === SyntaxKind.MinusToken) {
    const v = evalNumber(n.getOperand(), depth + 1);
    return v === undefined ? undefined : -v;
  }
  if (Node.isBinaryExpression(n)) {
    const l = evalNumber(n.getLeft(), depth + 1);
    const r = evalNumber(n.getRight(), depth + 1);
    if (l === undefined || r === undefined) return undefined;
    const op = n.getOperatorToken().getText();
    return op === "*" ? l * r : op === "+" ? l + r : op === "-" ? l - r : op === "/" && r !== 0 ? l / r : undefined;
  }
  if (Node.isIdentifier(n)) {
    for (const r of resolveIdentifier(n)) {
      if ("decl" in r && Node.isVariableDeclaration(r.decl)) return evalNumber(r.decl.getInitializer(), depth + 1);
    }
  }
  return undefined;
}

const EXPRESS_SEND = new Set(["send", "json", "jsonp", "sendStatus", "end", "redirect", "sendFile", "render"]);

/**
 * If this call sends an HTTP response (Express `res.status(400).json()`, `res.sendStatus(200)`, Fastify
 * `reply.code(500).send()`), the status it sends (200 when none is set).
 */
export function responseStatus(call: Node): number | undefined {
  if (!Node.isCallExpression(call)) return undefined;
  const callee = unwrap(call.getExpression());
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  const name = callee.getName();
  const { root } = flatten(callee);
  const module = moduleOf(root)?.module;
  if (module !== "express" && module !== "fastify") return undefined;
  if (module === "express" && !EXPRESS_SEND.has(name)) return undefined;
  if (module === "fastify" && name !== "send") return undefined;
  if (name === "sendStatus") return evalNumber(call.getArguments()[0]) ?? 200;
  if (name === "redirect") return 302;
  // res.status(400).json(...) / reply.code(500).send(...): the status call is the chain root.
  let n: Node = unwrap(callee.getExpression());
  while (Node.isCallExpression(n)) {
    const c = unwrap(n.getExpression());
    if (Node.isPropertyAccessExpression(c) && (c.getName() === "status" || c.getName() === "code")) return evalNumber(n.getArguments()[0]) ?? 200;
    n = Node.isPropertyAccessExpression(c) ? unwrap(c.getExpression()) : c;
  }
  return 200;
}

/** Status of a returned web Response (`new Response(b, { status })`, `Response.json`, `NextResponse.json`) or Lambda result. */
export function returnedStatus(expr: Node | undefined): number | undefined {
  if (!expr) return undefined;
  const n = unwrap(expr);
  const statusOf = (opts: Node | undefined) => {
    const o = opts && unwrap(opts);
    if (!o || !Node.isObjectLiteralExpression(o)) return 200;
    const p = o.getProperty("status") ?? o.getProperty("statusCode");
    return p && Node.isPropertyAssignment(p) ? (evalNumber(p.getInitializer()) ?? 200) : 200;
  };
  if (Node.isNewExpression(n) && /(^|\.)(Response|NextResponse)$/.test(n.getExpression().getText())) return statusOf(n.getArguments()?.[1]);
  if (Node.isCallExpression(n)) {
    const text = n.getExpression().getText();
    if (/^(Response|NextResponse)\.json$/.test(text)) return statusOf(n.getArguments()[1]);
    if (/^NextResponse\.(redirect|rewrite)$/.test(text)) return 302;
    if (/^(json|error)$/.test(text)) return statusOf(n.getArguments()[1]); // Remix/SvelteKit helpers
  }
  // Lambda proxy result: return { statusCode: 500, body }
  if (Node.isObjectLiteralExpression(n) && n.getProperty("statusCode")) return statusOf(n);
  return undefined;
}

/** What kind of failure a branch or catch responds to: bad signature, bad payload, or something else. */
export function failureReason(text: string): "signature" | "validation" | "other" {
  if (/signature|constructEvent|verify|hmac|timingSafeEqual|webhook.?secret/i.test(text)) return "signature";
  if (/\b(safeParse|parse|validate|valid|invalid|schema|success|required|missing|malformed|typeof|instanceof|zod|yup|joi)\b/i.test(text) || /!\s*(req|request|event|payload|body)\.\w+/.test(text)) {
    return "validation";
  }
  return "other";
}

/** A call whose promise nobody awaits: a bare expression statement, `void p`, or a `.then()` chain left floating. */
export function isFloating(call: Node): boolean {
  let n: Node = call;
  for (;;) {
    const p = n.getParent();
    if (!p) return false;
    if (Node.isParenthesizedExpression(p)) {
      n = p;
      continue;
    }
    // x.then(...).catch(...) as a statement
    if (Node.isPropertyAccessExpression(p) && ["then", "catch", "finally"].includes(p.getName())) {
      const outer = p.getParent();
      if (outer && Node.isCallExpression(outer)) {
        n = outer;
        continue;
      }
    }
    return Node.isExpressionStatement(p) || Node.isVoidExpression(p);
  }
}
