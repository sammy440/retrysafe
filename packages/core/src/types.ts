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
}

export interface HandlerReport {
  handler: Handler;
  effects: Effect[];
  guards: Guard[];
  checks: Check[];
  records: RecordStep[];
  /** Calls that undo a claim when the work fails (e.g. redis.del in a catch block). */
  releases: SourceLocation[];
  findings: Finding[];
}

export interface AnalysisResult {
  root: string;
  /** Number of candidate routes/workers inspected, including ones that were not at-least-once. */
  candidates: number;
  handlers: HandlerReport[];
  findings: Finding[];
}
