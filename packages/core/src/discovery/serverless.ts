import path from "node:path";
import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import { flatten, handlerFromDeclaration, moduleOf, resolveHandler, typeModule, unwrap, type FunctionLike } from "../project/resolve";
import type { Candidate } from "./types";

/** aws-lambda event types for sources that deliver at least once. */
const AT_LEAST_ONCE_EVENTS: Record<string, string> = {
  SQSEvent: "SQS",
  SNSEvent: "SNS",
  EventBridgeEvent: "EventBridge",
  KinesisStreamEvent: "Kinesis",
  DynamoDBStreamEvent: "DynamoDB Streams",
  S3Event: "S3",
  SQSHandler: "SQS",
  SNSHandler: "SNS",
  EventBridgeHandler: "EventBridge",
  KinesisStreamHandler: "Kinesis",
  DynamoDBStreamHandler: "DynamoDB Streams",
  S3Handler: "S3",
};

const HANDLER_EXPORTS = ["handler", "main", "default", "consumer", "processor"];

function typeName(node: Node | undefined): string | undefined {
  if (!node || !Node.isTypeReference(node)) return undefined;
  return node.getTypeName().getText().split(".").pop();
}

/** Which event source a Lambda function consumes, from its parameter or variable type, or `event.Records` usage. */
function eventSource(fn: FunctionLike, declType: Node | undefined): string | undefined {
  const fromDecl = typeName(declType);
  if (fromDecl && AT_LEAST_ONCE_EVENTS[fromDecl] && typeModule(declType)?.module === "aws-lambda") return AT_LEAST_ONCE_EVENTS[fromDecl];
  const param = (fn as { getParameters?: () => Node[] }).getParameters?.()[0];
  const paramType = param && Node.isParameterDeclaration(param) ? param.getTypeNode() : undefined;
  const fromParam = typeName(paramType);
  if (fromParam && AT_LEAST_ONCE_EVENTS[fromParam] && typeModule(paramType)?.module === "aws-lambda") return AT_LEAST_ONCE_EVENTS[fromParam];
  // Untyped JS: iterating `event.Records` is the batch-delivery shape shared by SQS, SNS, Kinesis, DynamoDB, S3.
  if (param && Node.isParameterDeclaration(param)) {
    const name = param.getName();
    const usesRecords = fn
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .some((pa) => pa.getName() === "Records" && pa.getExpression().getText() === name);
    if (usesRecords) return "event source (Records batch)";
  }
  return undefined;
}

export function discoverServerless(files: SourceFile[], root: string): Candidate[] {
  const out: Candidate[] = [];
  for (const sf of files) {
    const rel = path.relative(root, sf.getFilePath()).split(path.sep).join("/");
    for (const [name, decls] of sf.getExportedDeclarations()) {
      if (!HANDLER_EXPORTS.includes(name)) continue;
      for (const decl of decls) {
        const fn = handlerFromDeclaration(decl);
        if (!fn) continue;
        const declType = Node.isVariableDeclaration(decl) ? decl.getTypeNode() : undefined;
        const source = eventSource(fn, declType);
        if (!source) continue;
        out.push({
          kind: "serverless",
          framework: "aws-lambda",
          name: `Lambda ${rel}#${name} (${source})`,
          fn,
          anchor: fn,
          signals: ["event-source"],
          alwaysAtLeastOnce: true,
        });
      }
    }

    // sqs-consumer: Consumer.create({ queueUrl, handleMessage | handleMessageBatch })
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const { chain } = flatten(callee);
      if (chain[chain.length - 1] !== "create" || moduleOf(callee)?.module !== "sqs-consumer") continue;
      const opts = call.getArguments()[0] && unwrap(call.getArguments()[0]!);
      if (!opts || !Node.isObjectLiteralExpression(opts)) continue;
      for (const key of ["handleMessage", "handleMessageBatch"]) {
        const p = opts.getProperty(key);
        const value = p && Node.isPropertyAssignment(p) ? p.getInitializer() : p && Node.isShorthandPropertyAssignment(p) ? p.getNameNode() : p;
        const fn = value && (Node.isMethodDeclaration(value) ? value : resolveHandler(value));
        if (!fn) continue;
        out.push({
          kind: "queue-worker",
          framework: "sqs-consumer",
          name: `SQS consumer ${rel}:${call.getStartLineNumber()} (${key})`,
          fn,
          anchor: call,
          signals: ["queue"],
          alwaysAtLeastOnce: true,
        });
      }
    }
  }
  return out;
}
