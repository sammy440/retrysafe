import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEDUPE_NAME, EFFECT_CATALOG, chainMatches, moduleMatches } from "@retrysafe/core";

/** One call into a stubbed library during a verification run. */
export interface CallRecord {
  run: number;
  module: string;
  chain: string[];
  file?: string;
  line?: number;
  /** Mutates the outside world (per the effect catalog or common write method names). */
  effect: boolean;
  /** Suppressed by a stub that deduplicates: idempotency key, jobId, MessageDeduplicationId. */
  deduped?: string;
  /** Transactions the call ran in; if any rolled back, the call did not take effect. */
  tx?: number[];
  rolledBack?: boolean;
}

export interface Registration {
  kind: "route" | "use" | "worker" | "plugin";
  framework: string;
  method?: string;
  path?: string;
  owner: object;
  handlers: unknown[];
}

const WRITE_NAMES = /^(create|createMany|insert|insertMany|update|updateMany|upsert|delete|deleteMany|save|increment|decrement|send|sendMail|add|addBulk|publish|post|put|patch|request|execute|query|charge|transfer|initiate|incr|incrby|hincrby|lpush|rpush|xadd|updateOne|findOneAndUpdate|replaceOne|values|set)$/;

/** Paths of this runtime's own files, so stack frames inside it are skipped when locating the caller. */
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

class DuplicateKeyError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Shared state for one verification: the call log, a fake key-value/table store that gives guards real
 * semantics, and framework registrations captured while the user's modules load.
 */
export class SimulatedCrash extends Error {
  constructor() {
    super("retrysafe verify: simulated crash");
  }
}

export class VerifyRuntime {
  run = 0;
  /** Which delivery the current async context belongs to (deliveries may run concurrently). */
  readonly delivery = new AsyncLocalStorage<number>();
  private readonly txScope = new AsyncLocalStorage<number[]>();
  private txSeq = 0;
  /** Crash delivery 1 just before its Nth effect, and fail everything it does afterwards. */
  crashAt?: number;
  private effectsInRun1 = 0;
  private crashed = false;
  calls: CallRecord[] = [];
  registrations: Registration[] = [];
  responses: { run: number; status: number }[] = [];
  root: string;
  /** Rows of dedupe tables / Redis keys. */
  private kv = new Map<string, unknown>();
  private idempotency = new Map<string, unknown>();
  private txUndo: (() => void)[][] = [];
  currentHeaders = new Headers();
  private seq = 0;

  constructor(root: string) {
    this.root = root;
  }

  private where(): { file?: string; line?: number } {
    const stack = new Error().stack?.split("\n").slice(2) ?? [];
    for (const frame of stack) {
      const m = frame.match(/\(?((?:file:\/\/)?\/[^():]+):(\d+):\d+\)?$/);
      if (!m) continue;
      const file = m[1]!.replace(/^file:\/\//, "");
      if (file.startsWith(SELF_DIR) || file.includes("/node_modules/") || file.startsWith("node:")) continue;
      if (!file.startsWith(this.root)) continue;
      return { file: path.relative(this.root, file).split(path.sep).join("/"), line: Number(m[2]) };
    }
    return {};
  }

  currentRun(): number {
    return this.delivery.getStore() ?? this.run;
  }

  /** A dedupe claim or marker (processed-events insert, SET NX): logged, but not a business effect. */
  recordGuard(module: string, chain: string[]): CallRecord {
    return this.record(module, chain, undefined, false, true);
  }

  record(module: string, chain: string[], dedupedBy?: string, forceEffect = false, guard = false): CallRecord {
    const catalog = EFFECT_CATALOG.find((e) => moduleMatches(e.match.module, module) && chainMatches(e.match.callee, chain));
    const last = chain[chain.length - 1] ?? "";
    const effect = !guard && (forceEffect || !!catalog || WRITE_NAMES.test(last));
    const run = this.currentRun();
    if (run === 1 && this.crashAt !== undefined) {
      // A crash is process death: once it happens, nothing else in this delivery succeeds.
      if (this.crashed || (effect && !dedupedBy && ++this.effectsInRun1 === this.crashAt)) {
        this.crashed = true;
        throw new SimulatedCrash();
      }
    }
    const tx = this.txScope.getStore();
    const rec: CallRecord = { run, module, chain, effect, deduped: dedupedBy, tx: tx?.length ? tx : undefined, ...this.where() };
    this.calls.push(rec);
    return rec;
  }

  // ---- store with transaction rollback ----
  private put(key: string, value: unknown): void {
    this.kv.set(key, value);
    this.txUndo[this.txUndo.length - 1]?.push(() => this.kv.delete(key));
  }
  has(key: string): boolean {
    return this.kv.has(key);
  }
  get(key: string): unknown {
    return this.kv.get(key);
  }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const id = ++this.txSeq;
    const undo: (() => void)[] = [];
    this.txUndo.push(undo);
    try {
      return await this.txScope.run([...(this.txScope.getStore() ?? []), id], fn);
    } catch (err) {
      for (const u of undo) u();
      for (const c of this.calls) if (c.tx?.includes(id)) c.rolledBack = true;
      throw err;
    } finally {
      this.txUndo.splice(this.txUndo.indexOf(undo), 1);
    }
  }

  /** Insert a row; a duplicate key in a dedupe table fails like a unique constraint would. */
  insert(table: string, keyFields: Record<string, unknown>, code: string): void {
    const key = `row:${table}:${JSON.stringify(keyFields)}`;
    if (DEDUPE_NAME.test(table) && this.kv.has(key)) throw new DuplicateKeyError(`Unique constraint failed on ${table}`, code);
    this.put(key, keyFields);
  }
  /** Insert ignoring conflicts: true if a row was added. */
  insertIgnore(table: string, keyFields: Record<string, unknown>): boolean {
    const key = `row:${table}:${JSON.stringify(keyFields)}`;
    if (this.kv.has(key)) return false;
    this.put(key, keyFields);
    return true;
  }
  lookup(table: string, where: Record<string, unknown>): unknown {
    for (const [k, v] of this.kv) {
      if (!k.startsWith(`row:${table}:`)) continue;
      const row = v as Record<string, unknown>;
      if (Object.entries(where).every(([f, val]) => typeof val === "object" || row[f] === val)) return row;
    }
    return null;
  }
  redisSet(key: string, value: unknown, nx: boolean): "OK" | null {
    if (nx && this.kv.has(`redis:${key}`)) return null;
    this.put(`redis:${key}`, value);
    return "OK";
  }
  redisGet(key: string): unknown {
    return this.kv.get(`redis:${key}`) ?? null;
  }
  redisDel(key: string): number {
    return this.kv.delete(`redis:${key}`) ? 1 : 0;
  }
  /** Provider-side idempotency: the same key returns the first result and performs nothing. */
  idempotent(scope: string, key: string | undefined, make: () => unknown): { value: unknown; deduped: boolean } {
    if (!key) return { value: make(), deduped: false };
    const k = `${scope}:${key}`;
    if (this.idempotency.has(k)) return { value: this.idempotency.get(k), deduped: true };
    const value = make();
    this.idempotency.set(k, value);
    return { value, deduped: false };
  }
  /** Fresh store and log for another scenario; module registrations are kept. */
  reset(crashAt?: number): void {
    this.calls = [];
    this.responses = [];
    this.kv.clear();
    this.idempotency.clear();
    this.crashAt = crashAt;
    this.effectsInRun1 = 0;
    this.crashed = false;
  }

  id(prefix = "stub"): string {
    return `${prefix}_${++this.seq}`;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __retrysafeVerify: { runtime: VerifyRuntime; stub: (module: string) => unknown } | undefined;
}
