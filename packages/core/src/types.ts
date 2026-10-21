export interface SourceLocation {
  /** Path relative to the analyzed root, with forward slashes. */
  file: string;
  line: number;
  column: number;
}

export type HandlerKind = "http-webhook" | "queue-worker" | "serverless" | "server-action";

export interface Handler {
  id: string;
  kind: HandlerKind;
  framework: string;
  /** Human-readable name, e.g. "POST /api/webhooks/stripe" or `Worker queue "invoices"`. */
  name: string;
  location: SourceLocation;
  provider?: string;
  /** Why this was treated as at-least-once: "path", "signature-verify", "queue", "config". */
  signals: string[];
  /** Declared in config as never running concurrently with itself. */
  serialized?: boolean;
  /** How long the provider keeps retrying (config, then provider facts). */
  retryWindowHours?: number;
  /** Where the handler function itself starts (the route call may be elsewhere). */
  fnLocation?: SourceLocation;
}

export type EffectKind =
  | "db-write"
  | "payment"
  | "email"
  | "sms"
  | "enqueue"
  | "http-call"
  | "file-write"
  | "unknown";

export interface KeySpec {
  /** Zero-based argument index holding the options object. */
  arg: number;
  /** Property name inside that options object. */
  field: string;
}

export interface KeySource {
  /** "nondeterministic": differs on every run (Date.now(), uuid(), ...). "event-field": a property of the payload/job. */
  kind: "nondeterministic" | "event-field" | "constant" | "param" | "unknown";
  text: string;
  /** For event fields: the property path with local aliases expanded (session.id -> event.data.object.id). */
  expanded?: string;
  location: SourceLocation;
}

export interface Effect {
  kind: EffectKind;
  /** Source text of the callee, e.g. "prisma.order.create". */
  callee: string;
  module: string;
  idempotent: boolean | "unknown";
  /** Short explanation of the idempotency classification, if not obvious. */
  note?: string;
  location: SourceLocation;
  /** Call chain from the handler to this effect (call sites, outermost first). */
  path: SourceLocation[];
  acceptsIdempotencyKey?: KeySpec;
  hasIdempotencyKey: boolean;
  /** Where the idempotency key passed to this call comes from. */
  keySources?: KeySource[];
  inTransaction: boolean;
  /** Identity of the enclosing transaction (its call site), so rules can tell whether two steps commit together. */
  transaction?: string;
  /** Guards active on the path to this effect. */
  protectedBy: Guard[];
  order: number;
  /** The effect's promise is not awaited (fire-and-forget, forEach(async ...), void p). */
  floating?: boolean;
  /** Inside an in-code retry (p-retry, async-retry, or a retry loop) at this location. */
  retriedBy?: SourceLocation;
  /** Fields the write sets (data / set / $set keys), for ordering checks. */
  fields?: string[];
  /** Branches taken to reach this effect (if/case/catch ids), outermost first. Two effects can both run only if one's lineage is a prefix of the other's. */
  branch: string[];
}

export type GuardKind =
  | "unique-insert"
  | "redis-setnx"
  | "lookup-then-insert"
  | "idempotency-key"
  | "transaction"
  | "middleware";

export interface Guard {
  kind: GuardKind;
  /** true if backed by an atomic primitive; "unknown" when it depends on a schema we have not read. */
  atomic: boolean | "unknown";
  description: string;
  location: SourceLocation;
  path: SourceLocation[];
  order: number;
  transaction?: string;
  /** Where the dedupe key comes from. */
  keySources?: KeySource[];
  /** Table or model the guard reads or writes, and the columns involved. */
  table?: string;
  columns?: string[];
  /** How `atomic` was decided for unique inserts: from the schema, or not known. */
  schema?: "unique-constraint" | "no-unique-constraint" | "not-found";
  /** Schema file the decision came from. */
  schemaSource?: string;
  /** Expiry of the dedupe key (Redis EX/PX), when set. */
  ttlSeconds?: number;
}

/** A step that marks the event as handled: a claim (unique insert, SET NX) or a plain marker write after the work. */
export interface RecordStep {
  kind: "claim" | "marker-write";
  description: string;
  location: SourceLocation;
  path: SourceLocation[];
  order: number;
  transaction?: string;
  /** For claims: the guard this record also acts as. */
  guard?: Guard;
  ttlSeconds?: number;
}

/** An HTTP response the handler sends, or an uncaught throw (which the framework answers with 500). */
export interface ResponseInfo {
  status: number;
  location: SourceLocation;
  order: number;
  /** Depth of the call chain it was sent from (0 = handler body). */
  depth: number;
  /** What the enclosing branch or catch is handling. */
  reason?: "signature" | "validation" | "other";
  implicit?: boolean;
  /** Sent from a top-level statement of the handler body (not inside a branch). */
  topLevel: boolean;
}

export interface CatchInfo {
  location: SourceLocation;
  depth: number;
  rethrows: boolean;
  /** Status of responses sent from the catch block. */
  statuses: number[];
  /** Effects recorded inside the corresponding try block, and their callees. */
  tryEffects: number;
  tryEffectCallees: string[];
  /** The try block verifies a signature or parses the payload. */
  reason: "signature" | "validation" | "other";
  /** Reports per-record failures instead (SQS batchItemFailures, job.moveToFailed, nack). */
  reportsFailure: boolean;
}

export interface Check {
  kind: "signature-verify";
  callee: string;
  module: string;
  provider?: string;
  location: SourceLocation;
  order: number;
}

export type Severity = "error" | "warning" | "info";
export type Confidence = "high" | "medium" | "low";

export interface Finding {
  id: string;
  rule: string;
  severity: Severity;
  confidence: Confidence;
  handler: string;
  location: SourceLocation;
  message: string;
  effect?: Effect;
  failingSequence: string[];
  fix: string;
  /** Minimal code showing the safe pattern. */
  snippet?: string;
  /** Set when an inline suppression was found but not honored (e.g. no reason given). */
  suppressionError?: string;
}

export interface SuppressedFinding {
  finding: Finding;
  by: "inline" | "baseline";
  reason?: string;
}

export interface HandlerReport {
  handler: Handler;
  effects: Effect[];
  guards: Guard[];
  checks: Check[];
  records: RecordStep[];
  /** Calls that undo a claim when the work fails (e.g. redis.del in a catch block). */
  releases: SourceLocation[];
  responses: ResponseInfo[];
  catches: CatchInfo[];
  /** Event types the handler branches on (event.type === "x" / case "x"). */
  eventTypes: string[];
  /** The handler compares a version/timestamp before writing (for ordering checks). */
  checksOrdering: boolean;
  findings: Finding[];
}

export interface AnalysisResult {
  root: string;
  /** Number of candidate routes/workers inspected, including ones that were not at-least-once. */
  candidates: number;
  handlers: HandlerReport[];
  /** Active findings: not suppressed inline and not in the baseline. */
  findings: Finding[];
  suppressed: SuppressedFinding[];
}
