import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import { flatten, moduleOf, resolveFunction, textOf, unwrap } from "../project/resolve";
import type { Candidate } from "./types";

function importsProbot(sf: SourceFile): boolean {
  if (sf.getImportDeclarations().some((d) => d.getModuleSpecifierValue() === "probot")) return true;
  return sf.getDescendantsOfKind(SyntaxKind.CallExpression).some((c) => c.getExpression().getText() === "require" && textOf(c.getArguments()[0]) === "probot");
}

/** Probot apps: `app.on("issues.opened", handler)`. GitHub webhooks are redelivered, so these are at-least-once. */
export function discoverProbot(files: SourceFile[]): Candidate[] {
  const out: Candidate[] = [];
  for (const sf of files) {
    const fileUsesProbot = importsProbot(sf);
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "on") continue;
      const receiver = flatten(callee.getExpression()).root;
      if (moduleOf(receiver)?.module !== "probot" && !fileUsesProbot) continue;
      const [eventArg, handler] = call.getArguments();
      const e = eventArg && unwrap(eventArg);
      const events = e && Node.isArrayLiteralExpression(e) ? e.getElements().map((x) => textOf(x)) : [textOf(eventArg)];
      if (!events.length || events.some((x) => x === undefined || !/^[a-z_]+(\.[a-z_]+)?$/.test(x))) continue;
      const fn = handler && resolveFunction(handler);
      if (!fn) continue;
      out.push({
        kind: "http-webhook",
        framework: "probot",
        name: `Probot on ${events.join(", ")}`,
        fn,
        anchor: call,
        signals: ["probot"],
        alwaysAtLeastOnce: true,
      });
    }
  }
  return out;
}
