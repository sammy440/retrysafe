import { Node } from "ts-morph";
import type { GuardPrimitive } from "../guards/detect";
import { flatten, textOf, unwrap, type CallLike } from "../project/resolve";
import type { EffectKind, KeySpec } from "../types";
import { AWS_COMMANDS, DEDUPE_NAME } from "./catalog";

export type AwsResult =
  | { type: "effect"; kind: EffectKind; idempotent: boolean | "unknown"; note?: string; label: string; acceptsKey?: KeySpec; keyNode?: Node }
  | { type: "guard"; guard: GuardPrimitive };

function prop(obj: Node | undefined, name: string): Node | undefined {
  const o = obj && unwrap(obj);
  if (!o || !Node.isObjectLiteralExpression(o)) return undefined;
  const p = o.getProperty(name);
  if (p && Node.isPropertyAssignment(p)) return p.getInitializer();
  if (p && Node.isShorthandPropertyAssignment(p)) return p.getNameNode();
  return undefined;
}

/** AWS SDK v3: `client.send(new SendMessageCommand(input))`, classified by command name. */
export function classifyAwsSend(call: CallLike): AwsResult | undefined {
  if (!Node.isCallExpression(call)) return undefined;
  const cmd = call.getArguments()[0] && unwrap(call.getArguments()[0]!);
  if (!cmd || !Node.isNewExpression(cmd)) return undefined;
  const { root, chain } = flatten(cmd.getExpression());
  const name = chain[chain.length - 1] ?? root.getText();
  const fact = AWS_COMMANDS[name];
  if (!fact) return undefined;
  const input = cmd.getArguments()[0];
  const table = textOf(prop(input, "TableName"));

  if (fact.classify === "dynamo") {
    const condition = textOf(prop(input, "ConditionExpression")) ?? "";
    if (/^Put/.test(name) && /attribute_not_exists/.test(condition)) {
      // A conditional put throws ConditionalCheckFailed on a duplicate: an atomic claim.
      const item = prop(input, "Item");
      return {
        type: "guard",
        guard: { kind: "unique-insert", atomic: true, description: `conditional put into ${table ?? "table"}`, selfGuarding: true, duplicateWhen: "unknown", keyNodes: item ? [item] : undefined },
      };
    }
    if (/^Update/.test(name)) {
      const expr = textOf(prop(input, "UpdateExpression")) ?? "";
      const relative = /\bADD\b|list_append|=\s*[#\w.]+\s*[+-]/i.test(expr);
      return { type: "effect", kind: "db-write", idempotent: !relative, note: relative ? "relative update expression" : undefined, label: name };
    }
    return { type: "effect", kind: "db-write", idempotent: true, note: table && DEDUPE_NAME.test(table) ? `put into ${table}` : undefined, label: name };
  }

  const keyNode = fact.acceptsKey ? prop(input, fact.acceptsKey.field) : undefined;
  return {
    type: "effect",
    kind: fact.kind,
    idempotent: fact.idempotent,
    note: fact.note,
    label: name,
    acceptsKey: fact.acceptsKey ? { arg: 0, field: fact.acceptsKey.field } : undefined,
    keyNode,
  };
}
