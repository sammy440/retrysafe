import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import { flatten, moduleOf, resolveHandler, textOf } from "../project/resolve";
import type { Candidate } from "./types";

export function discoverQueues(files: SourceFile[]): Candidate[] {
  const out: Candidate[] = [];
  for (const sf of files) {
    for (const expr of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      const ctor = expr.getExpression();
      const { root, chain } = flatten(ctor);
      const ctorName = chain[chain.length - 1] ?? root.getText();
      if (ctorName !== "Worker" || moduleOf(ctor)?.module !== "bullmq") continue;
      const [nameArg, processor] = expr.getArguments();
      const fn = processor && resolveHandler(processor);
      if (!fn) continue;
      const queue = textOf(nameArg) ?? nameArg?.getText() ?? "?";
      out.push({
        kind: "queue-worker",
        framework: "bullmq",
        name: `Worker queue "${queue}"`,
        fn,
        anchor: expr,
        signals: ["queue"],
        alwaysAtLeastOnce: true,
      });
    }

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "process") continue;
      if (moduleOf(callee.getExpression())?.module !== "bull") continue;
      const args = call.getArguments();
      const last = args[args.length - 1];
      const fn = last && resolveHandler(last);
      if (!fn) continue;
      const queueVar = flatten(callee.getExpression()).root.getText();
      const jobName = args.length > 1 ? textOf(args[0]) : undefined;
      out.push({
        kind: "queue-worker",
        framework: "bull",
        name: `Worker ${queueVar}${jobName ? ` job "${jobName}"` : ""}`,
        fn,
        anchor: call,
        signals: ["queue"],
        alwaysAtLeastOnce: true,
      });
    }
  }
  return out;
}
