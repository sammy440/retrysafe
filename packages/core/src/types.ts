export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export type HandlerKind = "http-webhook" | "queue-worker" | "serverless" | "server-action";

export interface Handler {
  id: string;
  kind: HandlerKind;
  framework: string;
  name: string;
  location: SourceLocation;
  provider?: string;
  signals: string[];
  serialized?: boolean;
  retryWindowHours?: number;
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
  arg: number;
  field: string;
}

export interface KeySource {
  kind: "nondeterministic" | "event-field" | "constant" | "param" | "unknown";
  text: string;
  expanded?: string;
  location: SourceLocation;
}

export interface Effect {
  kind: EffectKind;
  callee: string;
  module: string;
  idempotent: boolean | "unknown";
  note?: string;
  location: SourceLocation;
  path: SourceLocation[];
  acceptsIdempotencyKey?: KeySpec;
  hasIdempotencyKey: boolean;
  keySources?: KeySource[];
  inTransaction: boolean;
  transaction?: string;
  protectedBy: Guard[];
  order: number;
  floating?: boolean;
  retriedBy?: SourceLocation;
  fields?: string[];
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
  atomic: boolean | "unknown";
  description: string;
  location: SourceLocation;
  path: SourceLocation[];
  order: number;
  transaction?: string;
  keySources?: KeySource[];
  table?: string;
  columns?: string[];
  schema?: "unique-constraint" | "no-unique-constraint" | "not-found";
  schemaSource?: string;
  ttlSeconds?: number;
}

export interface RecordStep {
  kind: "claim" | "marker-write";
  description: string;
  location: SourceLocation;
  path: SourceLocation[];
  order: number;
  transaction?: string;
  guard?: Guard;
  ttlSeconds?: number;
}

export interface ResponseInfo {
  status: number;
  location: SourceLocation;
  order: number;
  depth: number;
  reason?: "signature" | "validation" | "other";
  implicit?: boolean;
  topLevel: boolean;
}

export interface CatchInfo {
  location: SourceLocation;
  depth: number;
  rethrows: boolean;
  statuses: number[];
  tryEffects: number;
  tryEffectCallees: string[];
  reason: "signature" | "validation" | "other";
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
  snippet?: string;
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
  releases: SourceLocation[];
  responses: ResponseInfo[];
  catches: CatchInfo[];
  eventTypes: string[];
  checksOrdering: boolean;
  findings: Finding[];
}

export interface AnalysisResult {
  root: string;
  candidates: number;
  handlers: HandlerReport[];
  findings: Finding[];
  suppressed: SuppressedFinding[];
}
