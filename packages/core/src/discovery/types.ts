import type { Node } from "ts-morph";
import type { FunctionLike } from "../project/resolve";
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
}

const WEBHOOK_PATH = /web-?hooks?|(^|\/)hooks?(\/|$)|callback|notif|(^|\/)ipn(\/|$)/i;

export function pathSignals(routePath: string | undefined): string[] {
  return routePath && WEBHOOK_PATH.test(routePath) ? ["path"] : [];
}
