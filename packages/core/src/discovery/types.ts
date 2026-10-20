import { Node } from "ts-morph";
import type { CustomGuard, GuardPrimitive } from "../guards/detect";
import { calleeOf, isFunctionLike, moduleOf, resolveCall, resolveFunction, unwrap, type FunctionLike } from "../project/resolve";
import type { HandlerKind } from "../types";

/** A route or worker that may be at-least-once. Analysis decides using `signals` plus what the walk finds. */
export interface Candidate {
  kind: HandlerKind;
  framework: string;
  name: string;
  /** Route path, when there is one. */
  routePath?: string;
  fn: FunctionLike;
  /** Node to report the handler location at. */
  anchor: Node;
  /** Static reasons this is at-least-once ("path", "queue"). Signature verification is added after the walk. */
  signals: string[];
  /** true if at-least-once regardless of signals (queue workers). */
  alwaysAtLeastOnce: boolean;
  /** Middleware that runs before the handler, in order (app.use, route-level middleware, preHandler hooks). */
  middleware?: Node[];
}

/** Idempotency middleware packages: trusted as guards for the routes they wrap. */
const IDEMPOTENCY_MIDDLEWARE = new Set(["express-idempotency", "@node-idempotency/express", "@node-idempotency/nestjs", "express-idempotency-middleware", "idempotency-middleware"]);

export interface ResolvedMiddleware {
  fns: FunctionLike[];
  guards: { node: Node; guard: GuardPrimitive }[];
}

/**
 * Split middleware arguments into project functions to walk and calls to trusted guard middleware.
 * Factories (`dedupe()` returning a middleware) are followed to the function they return.
 */
export function resolveMiddleware(nodes: Node[], custom: CustomGuard[]): ResolvedMiddleware {
  const out: ResolvedMiddleware = { fns: [], guards: [] };
  for (const raw of nodes) {
    const n = unwrap(raw);
    if (Node.isArrayLiteralExpression(n)) {
      const inner = resolveMiddleware(n.getElements(), custom);
      out.fns.push(...inner.fns);
      out.guards.push(...inner.guards);
      continue;
    }
    if (Node.isCallExpression(n)) {
      const text = calleeOf(n).getText().replace(/\s+/g, "");
      const configured = custom.find((g) => text === g.callee || text.endsWith(`.${g.callee}`));
      const module = moduleOf(n.getExpression())?.module;
      if (configured || (module && IDEMPOTENCY_MIDDLEWARE.has(module))) {
        out.guards.push({
          node: n,
          guard: { kind: "middleware", atomic: configured?.atomic ?? "unknown", description: `${text}() middleware`, selfGuarding: true, duplicateWhen: "unknown" },
        });
        continue;
      }
      const target = resolveCall(n);
      if (target.kind === "local") {
        const body = target.fn.getBody();
        const returned = body && (Node.isBlock(body) ? body.getStatements().find(Node.isReturnStatement)?.getExpression() : body);
        const fn = returned && (isFunctionLike(unwrap(returned)) ? (unwrap(returned) as FunctionLike) : resolveFunction(returned));
        if (fn) out.fns.push(fn);
      }
      continue;
    }
    const fn = resolveFunction(n);
    if (fn) out.fns.push(fn);
  }
  return out;
}

const WEBHOOK_PATH = /web-?hooks?|(^|\/)hooks?(\/|$)|callback|notif|(^|\/)ipn(\/|$)/i;

export function pathSignals(routePath: string | undefined): string[] {
  return routePath && WEBHOOK_PATH.test(routePath) ? ["path"] : [];
}
