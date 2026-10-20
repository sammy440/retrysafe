import { randomUUID } from "node:crypto";
import { DEDUPE_NAME } from "@retrysafe/core";
import type { Registration, VerifyRuntime } from "./runtime";

/**
 * Recording stand-ins for the libraries a handler talks to. Each stub is a Proxy that accepts any
 * property access, call, or construction and logs calls; families that guards depend on (Redis,
 * Prisma, SQL, Drizzle/Knex, Mongoose, Stripe keys, queue job ids, AWS conditional puts) get just
 * enough real behavior that a correct guard actually stops the second delivery.
 */

const YIELD = () => new Promise<void>((r) => setImmediate(r));
const KEY_FIELD = /^(id|_id|key)$|key$|id$|_id$/i;

function keyFields(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return { value: data };
  const entries = Object.entries(data as Record<string, unknown>);
  const keys = entries.filter(([k]) => KEY_FIELD.test(k));
  return Object.fromEntries(keys.length ? keys : entries);
}

/** A value standing in for data returned by a stubbed call: any property works, ids are strings. */
function dataValue(rt: VerifyRuntime): unknown {
  const target = /* biome-ignore lint/complexity/useArrowFunction: Proxy targets must be constructible */ function () {} as unknown as Record<PropertyKey, unknown>;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.iterator) return [][Symbol.iterator].bind([]);
      if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") return () => rt.id("value");
      if (prop === "toJSON") return () => ({});
      if (prop === "length" || prop === "count" || prop === "rowCount" || prop === "affectedRows") return 1;
      if (prop === "rows") return [];
      if (prop === "id" || prop === "_id" || (typeof prop === "string" && /Id$/.test(prop))) return rt.id(String(prop));
      if (prop === "error") return null;
      return dataValue(rt);
    },
    apply: () => dataValue(rt),
  });
}

type Handler = (chain: string[], args: unknown[], self: Stub) => unknown;
const DEFAULT = Symbol("default");

interface Stub {
  rt: VerifyRuntime;
  module: string;
  record(chain: string[], dedupedBy?: string): void;
  child(chain: string[]): unknown;
}

/** Generic chainable proxy; `behave` may return DEFAULT to fall back to "record and return a value". */
function proxy(rt: VerifyRuntime, module: string, chain: string[], behave?: Handler, construct?: Handler): unknown {
  const self: Stub = {
    rt,
    module,
    record: (c, dedupedBy) => rt.record(module, c, dedupedBy),
    child: (c) => proxy(rt, module, c, behave, construct),
  };
  const target = /* biome-ignore lint/complexity/useArrowFunction: Proxy targets must be constructible */ function () {} as unknown as object;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop === "__esModule") return true;
      if (prop === "default" && chain.length === 0) return proxy(rt, module, chain, behave, construct);
      if (prop === Symbol.toPrimitive || prop === "toString") return () => `[${module}]`;
      if (typeof prop === "symbol") return undefined;
      return proxy(rt, module, [...chain, prop], behave, construct);
    },
    apply(_t, _this, args: unknown[]) {
      const out = behave?.(chain, args, self);
      if (out !== DEFAULT && out !== undefined) return out;
      self.record(chain);
      return result(rt, module, chain, behave, construct);
    },
    construct(_t, args: unknown[]) {
      const out = construct?.(chain, args, self);
      if (out !== DEFAULT && out !== undefined) return out as object;
      // new Stripe(key), new PrismaClient(), new Redis(): a client rooted at the module.
      return proxy(rt, module, [], behave, construct) as object;
    },
  });
}

/**
 * What a generic stubbed call returns: awaitable (resolving to a data value) and also usable as a client,
 * since factories like nodemailer.createTransport(), twilio(sid), or Paystack(key) return one synchronously.
 */
function result(rt: VerifyRuntime, module: string, chain: string[], behave?: Handler, construct?: Handler): unknown {
  const client = proxy(rt, module, chain, behave, construct) as Record<PropertyKey, unknown>;
  return new Proxy(/* biome-ignore lint/complexity/useArrowFunction: Proxy targets must be constructible */ function () {} as unknown as object, {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(dataValue(rt));
      if (prop === "catch" || prop === "finally") return () => result(rt, module, chain, behave, construct);
      return client[prop];
    },
    apply: (_t, _this, args) => (client as unknown as (...a: unknown[]) => unknown)(...args),
    construct: (_t, args) => new (client as unknown as new (...a: unknown[]) => object)(...args),
  });
}

// ---------- families ----------

function redisStub(rt: VerifyRuntime, module: string): unknown {
  return proxy(rt, module, [], (chain, args, s) => {
    const op = (chain[chain.length - 1] ?? "").toLowerCase();
    const key = String(args[0]);
    if (op === "createclient") return s.child([]);
    if (op === "connect" || op === "quit" || op === "disconnect" || op === "on") return Promise.resolve(s.child([]));
    const flags = args.slice(2).map((a) => (typeof a === "string" ? a.toUpperCase() : a));
    const nx = flags.includes("NX") || args.slice(2).some((a) => a && typeof a === "object" && ("NX" in a || "nx" in a)) || op === "setnx";
    return (async () => {
      await YIELD();
      if (op === "set" || op === "setnx" || op === "setex") {
        rt.recordGuard(s.module, chain);
        const r = rt.redisSet(key, op === "setex" ? args[2] : args[1], nx);
        return op === "setnx" ? (r ? 1 : 0) : r;
      }
      if (op === "get") return rt.redisGet(key);
      if (op === "exists") return rt.redisGet(key) === null ? 0 : 1;
      if (op === "del" || op === "unlink") return rt.redisDel(key);
      if (op === "expire" || op === "ttl") return 1;
      s.record(chain);
      return 1;
    })();
  });
}

function prismaStub(rt: VerifyRuntime): unknown {
  let root: unknown;
  root = proxy(rt, "@prisma/client", [], (chain, args, s) => {
    const op = chain[chain.length - 1] ?? "";
    const model = chain[chain.length - 2] ?? "";
    const a = (args[0] ?? {}) as Record<string, any>;
    if (op === "$transaction") {
      return rt.transaction(async () => (typeof args[0] === "function" ? (args[0] as (tx: unknown) => unknown)(root) : Promise.all(args[0] as unknown[])));
    }
    if (op.startsWith("$") && op !== "$executeRaw" && op !== "$executeRawUnsafe" && op !== "$queryRaw") return Promise.resolve(undefined);
    return (async () => {
      await YIELD();
      if (op === "create") {
        if (DEDUPE_NAME.test(model)) rt.recordGuard("@prisma/client", chain);
        else s.record(chain);
        rt.insert(model, keyFields(a.data), "P2002");
        return { ...(a.data ?? {}), id: a.data?.id ?? rt.id(model) };
      }
      if (op === "createMany") {
        s.record(chain);
        const rows = Array.isArray(a.data) ? a.data : [a.data];
        let count = 0;
        for (const r of rows) {
          if (a.skipDuplicates) count += rt.insertIgnore(model, keyFields(r)) ? 1 : 0;
          else {
            rt.insert(model, keyFields(r), "P2002");
            count++;
          }
        }
        return { count };
      }
      if (/^find(Unique|First)(OrThrow)?$/.test(op)) return rt.lookup(model, a.where ?? {});
      if (op === "findMany") return [];
      if (op === "count") return rt.lookup(model, a.where ?? {}) ? 1 : 0;
      s.record(chain);
      return dataValue(rt);
    })();
  });
  return root;
}

function sqlInsert(rt: VerifyRuntime, sql: string, params: unknown[]): { rowCount: number; rows: unknown[] } | undefined {
  const m = sql.match(/insert\s+(?:ignore\s+)?into\s+["`]?([\w.]+)/i);
  if (!m) return undefined;
  const table = m[1]!;
  const key = { params: JSON.stringify(params ?? []) };
  if (/on\s+conflict[\s\S]*do\s+nothing|insert\s+ignore/i.test(sql)) {
    const added = rt.insertIgnore(table, key);
    const last = rt.calls[rt.calls.length - 1];
    if (!added && last) last.deduped = "conflict ignored";
    return { rowCount: added ? 1 : 0, rows: added ? [{}] : [] };
  }
  rt.insert(table, key, "23505");
  return { rowCount: 1, rows: [{}] };
}

function sqlStub(rt: VerifyRuntime, module: string): unknown {
  return proxy(rt, module, [], (chain, args, s) => {
    const op = chain[chain.length - 1] ?? "";
    if (op === "connect") return Promise.resolve(s.child([]));
    if (op === "release" || op === "end" || op === "on") return undefined;
    if (op !== "query" && op !== "execute" && op !== "sql") return DEFAULT;
    const sql = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string })?.text ?? "");
    return (async () => {
      await YIELD();
      if (/^\s*(select|with|begin|commit|rollback|set|show)\b/i.test(sql)) {
        const from = sql.match(/from\s+["`]?([\w.]+)/i)?.[1];
        const row = from && rt.lookup(from, {});
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      const table = sql.match(/insert\s+(?:ignore\s+)?into\s+["`]?([\w.]+)/i)?.[1];
      if (table && DEDUPE_NAME.test(table)) rt.recordGuard(s.module, chain);
      else s.record(chain);
      return sqlInsert(rt, sql, args[1] as unknown[]) ?? { rows: [], rowCount: 1 };
    })();
  });
}

/** Drizzle / Knex query builders: collect the chain, execute on await. */
function builderStub(rt: VerifyRuntime, module: string): unknown {
  const tableName = (t: unknown) => (typeof t === "string" ? t : ((t as { __table?: string })?.__table ?? "table"));
  const make = (state: { ops: string[]; table?: string; values?: unknown; loc?: object }) => {
    const b: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
            (async () => {
              await YIELD();
              const ops = state.ops;
              const write = ops.find((o) => /^(insert|update|delete|del|increment|decrement)$/.test(o));
              if (!write) return state.table ? [rt.lookup(state.table, {})].filter(Boolean) : [];
              if (state.table && DEDUPE_NAME.test(state.table)) rt.recordGuard(module, ops);
              else rt.record(module, ops, undefined, true);
              rt.calls[rt.calls.length - 1] = { ...rt.calls[rt.calls.length - 1]!, ...(state.loc as object) };
              if (write === "insert" && state.table) {
                if (ops.includes("onConflictDoNothing") || ops.includes("ignore")) {
                  if (rt.insertIgnore(state.table, keyFields(state.values))) return [{}];
                  // Nothing was inserted: not a performed effect.
                  rt.calls[rt.calls.length - 1]!.deduped = "conflict ignored";
                  return [];
                }
                rt.insert(state.table, keyFields(state.values), "23505");
              }
              return [{}];
            })().then(resolve, reject);
          };
        }
        if (typeof prop === "symbol") return undefined;
        return (...args: unknown[]) => {
          if (prop === "insert" || prop === "update" || prop === "delete" || prop === "into" || prop === "from" || prop === "table") {
            state.table = state.table ?? (args[0] !== undefined && !(typeof args[0] === "object" && !(args[0] as { __table?: string }).__table) ? tableName(args[0]) : undefined);
          }
          if (prop === "values" || (prop === "insert" && module === "knex")) state.values = args[0];
          state.ops.push(String(prop));
          return b;
        };
      },
    });
    return b;
  };
  const where = () => {
    const rec = rt.record(module, ["builder"]);
    rt.calls.pop();
    return { file: rec.file, line: rec.line };
  };
  return proxy(rt, module, [], (chain, args) => {
    const op = chain[chain.length - 1] ?? "";
    if (/^(pgTable|mysqlTable|sqliteTable)$/.test(op)) return { __table: String(args[0]) };
    if (op === "transaction") return rt.transaction(async () => (args[0] as (tx: unknown) => unknown)(builderStub(rt, module)));
    if (chain.length === 0 && module === "knex" && typeof args[0] === "string") return make({ ops: [], table: args[0], loc: where() });
    if (chain.length === 0) return builderStub(rt, module); // drizzle(url) / knex(config)
    if (["insert", "update", "delete", "select", "selectDistinct"].includes(op)) {
      const state = { ops: [op], table: op === "select" || op === "selectDistinct" ? undefined : tableName(args[0]), loc: where() };
      return make(state);
    }
    if (op === "sql" || op === "eq" || op === "and" || op === "raw") return dataValue(rt);
    return DEFAULT;
  });
}

function mongooseStub(rt: VerifyRuntime): unknown {
  const model = (name: string) => {
    const ctor = function (this: unknown, doc: unknown) {
      return { ...(doc as object), save: async () => { rt.record("mongoose", [name, "save"]); rt.insert(name, keyFields(doc), "11000"); return doc; } };
    } as unknown as Record<string, unknown>;
    return new Proxy(ctor, {
      get(_t, op) {
        if (typeof op === "symbol" || op === "then") return undefined;
        return async (...args: unknown[]) => {
          await YIELD();
          const a = args as Record<string, any>[];
          if (op === "create" || op === "insertMany") {
            if (DEDUPE_NAME.test(name)) rt.recordGuard("mongoose", [name, op]);
            else rt.record("mongoose", [name, op]);
            for (const d of Array.isArray(a[0]) ? a[0] : [a[0]]) rt.insert(name, keyFields(d), "11000");
            return a[0];
          }
          if (/^(findOne|findById|exists)$/.test(op)) return rt.lookup(name, op === "findById" ? { _id: a[0] } : (a[0] ?? {}));
          if (op === "updateOne" && a[2]?.upsert) {
            rt.record("mongoose", [name, op]);
            return { upsertedCount: rt.insertIgnore(name, keyFields(a[0])) ? 1 : 0 };
          }
          rt.record("mongoose", [name, op]);
          return dataValue(rt);
        };
      },
      construct: (_t, args) => (ctor as unknown as (d: unknown) => object)(args[0]),
    });
  };
  return proxy(rt, "mongoose", [], (chain, args) => {
    const op = chain[chain.length - 1] ?? "";
    if (op === "model") return model(String(args[0]));
    if (op === "connect") return Promise.resolve();
    if (op === "transaction") return rt.transaction(async () => (args[0] as (s: unknown) => unknown)({}));
    return DEFAULT;
  }, (chain) => (chain[chain.length - 1] === "Schema" ? {} : DEFAULT));
}

/** Providers that deduplicate on an idempotency key: the first call per key performs, the rest return its result. */
function keyedStub(rt: VerifyRuntime, module: string, keyOf: (chain: string[], args: unknown[]) => string | undefined, extra?: Handler): unknown {
  return proxy(rt, module, [], (chain, args, s) => {
    const special = extra?.(chain, args, s);
    if (special !== undefined && special !== DEFAULT) return special;
    const key = keyOf(chain, args);
    const r = rt.idempotent(`${module}:${chain.join(".")}`, key, () => dataValue(rt));
    s.record(chain, r.deduped ? "idempotency key" : undefined);
    return Promise.resolve(r.value);
  });
}

function parseBody(body: unknown): unknown {
  try {
    if (typeof body === "string") return JSON.parse(body);
    if (body instanceof Uint8Array) return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    // not JSON
  }
  return body;
}

function awsStub(rt: VerifyRuntime, module: string): unknown {
  return proxy(
    rt,
    module,
    [],
    (chain, args, s) => {
      if (chain[chain.length - 1] !== "send") return DEFAULT;
      const cmd = args[0] as { __command?: string; input?: Record<string, any> };
      const name = cmd?.__command ?? "Command";
      const input = cmd?.input ?? {};
      return (async () => {
        await YIELD();
        if (/^Put(Item)?Command$/.test(name) && /attribute_not_exists/.test(String(input.ConditionExpression ?? ""))) {
          rt.recordGuard(s.module, [name]);
          if (!rt.insertIgnore(`dynamo:${input.TableName}`, keyFields(input.Item))) {
            const err = new Error("The conditional request failed") as Error & { name: string };
            err.name = "ConditionalCheckFailedException";
            throw err;
          }
          return {};
        }
        const key = input.MessageDeduplicationId ?? input.ClientRequestToken;
        const r = rt.idempotent(`${module}:${name}`, key, () => ({}));
        s.record([name], r.deduped ? "deduplication id" : undefined);
        return r.value;
      })();
    },
    (chain, args) => {
      const name = chain[chain.length - 1] ?? "";
      return /Command$/.test(name) ? { __command: name, input: args[0] } : DEFAULT;
    },
  );
}

// ---------- frameworks (captured registrations) ----------

function expressStub(rt: VerifyRuntime): unknown {
  const makeApp = (): Record<string, unknown> => {
    const app: Record<string, unknown> = {};
    const register = (method: string) => (...args: unknown[]) => {
      const path = typeof args[0] === "string" ? args[0] : undefined;
      if (method === "use") {
        rt.registrations.push({ kind: "use", framework: "express", path: path ?? "/", owner: app, handlers: path === undefined ? args : args.slice(1) });
      } else if (path !== undefined) {
        rt.registrations.push({ kind: "route", framework: "express", method, path, owner: app, handlers: args.slice(1) });
      }
      return app;
    };
    for (const m of ["get", "post", "put", "patch", "delete", "all", "use", "options", "head"]) app[m] = register(m);
    app.route = (path: string) => {
      const r: Record<string, unknown> = {};
      for (const m of ["get", "post", "put", "patch", "delete", "all"]) {
        r[m] = (...hs: unknown[]) => {
          rt.registrations.push({ kind: "route", framework: "express", method: m, path, owner: app, handlers: hs });
          return r;
        };
      }
      return r;
    };
    app.listen = (...a: unknown[]) => {
      const cb = a.find((x) => typeof x === "function") as (() => void) | undefined;
      cb?.();
      return { close() {} };
    };
    app.set = () => app;
    app.disable = () => app;
    app.enable = () => app;
    app.locals = {};
    return app;
  };
  const passthrough = () => (_req: unknown, _res: unknown, next: () => void) => next();
  const express = Object.assign(() => makeApp(), {
    Router: () => makeApp(),
    json: passthrough,
    raw: passthrough,
    text: passthrough,
    urlencoded: passthrough,
    static: passthrough,
    default: undefined as unknown,
    __esModule: true,
  });
  express.default = express;
  return express;
}

function fastifyStub(rt: VerifyRuntime): unknown {
  const makeApp = (prefix: string, pending: Promise<unknown>[]): Record<string, unknown> => {
    const app: Record<string, unknown> = {};
    const join = (u: string) => `/${`${prefix}/${u}`.split("/").filter(Boolean).join("/")}`;
    const route = (method: string, url: string, opts: Record<string, unknown> | undefined, handler: unknown) =>
      rt.registrations.push({ kind: "route", framework: "fastify", method, path: join(url), owner: app, handlers: [...[opts?.onRequest, opts?.preHandler].flat().filter(Boolean), handler ?? opts?.handler] });
    for (const m of ["get", "post", "put", "patch", "delete", "all"]) {
      app[m] = (url: string, a?: unknown, b?: unknown) => {
        route(m, url, (typeof a === "object" ? a : undefined) as Record<string, unknown>, typeof a === "function" ? a : b);
        return app;
      };
    }
    app.route = (o: Record<string, any>) => {
      for (const m of [o.method].flat()) route(String(m).toLowerCase(), o.url ?? o.path, o, o.handler);
      return app;
    };
    app.register = (plugin: (a: unknown, o: unknown) => unknown, opts?: { prefix?: string }) => {
      pending.push(Promise.resolve(plugin(makeApp(join(opts?.prefix ?? ""), pending), opts ?? {})));
      return app;
    };
    app.addHook = () => app;
    app.decorate = () => app;
    app.addContentTypeParser = () => app;
    app.listen = async () => "http://localhost";
    app.ready = async () => Promise.all(pending);
    app.log = { info() {}, error() {}, warn() {} };
    return app;
  };
  const Fastify = () => {
    const pending: Promise<unknown>[] = [];
    const app = makeApp("", pending);
    (globalThis as Record<string, unknown>).__retrysafeFastifyReady = () => Promise.all(pending);
    return app;
  };
  return Object.assign(Fastify, { default: Fastify, fastify: Fastify, __esModule: true });
}

function queueStub(rt: VerifyRuntime, module: string): unknown {
  return proxy(
    rt,
    module,
    [],
    (chain, args, s) => {
      const op = chain[chain.length - 1] ?? "";
      if (op === "process") {
        rt.registrations.push({ kind: "worker", framework: module, path: "bull", owner: {}, handlers: [args[args.length - 1]] });
        return undefined;
      }
      if (op === "on" || op === "close" || op === "waitUntilReady") return Promise.resolve();
      if (op === "add") {
        const r = rt.idempotent(`${module}:add`, (args[2] as { jobId?: string })?.jobId, () => ({ id: rt.id("job") }));
        s.record(chain, r.deduped ? "jobId" : undefined);
        return Promise.resolve(r.value);
      }
      return DEFAULT;
    },
    (chain, args) => {
      const name = chain[chain.length - 1] ?? "";
      if (name === "Worker") {
        rt.registrations.push({ kind: "worker", framework: module, path: String(args[0]), owner: {}, handlers: [args[1]] });
        return { on() {}, close: async () => {} };
      }
      return DEFAULT;
    },
  );
}

/** Webhook verification helpers: accept the payload as-is. */
function verifierStub(rt: VerifyRuntime, module: string): unknown {
  return proxy(rt, module, [], (chain, args) => {
    const op = chain[chain.length - 1] ?? "";
    if (op === "constructEvent" || op === "verify" || op === "unwrap") return parseBody(args[0]);
    if (op === "constructEventAsync" || op === "verifyAndReceive") return Promise.resolve(parseBody(args[0]));
    if (op === "validateRequest" || op === "validate") return true;
    return DEFAULT;
  });
}

const random = () => randomUUID();

/** Build the stub for one module specifier. */
export function stubFor(rt: VerifyRuntime, module: string): unknown {
  if (["ioredis", "redis", "@upstash/redis"].includes(module)) return redisStub(rt, module);
  if (module === "@prisma/client") return prismaStub(rt);
  if (["pg", "mysql2", "mysql2/promise", "@neondatabase/serverless", "@vercel/postgres", "postgres"].includes(module)) return sqlStub(rt, module);
  if (module === "knex" || module.startsWith("drizzle-orm")) return builderStub(rt, module);
  if (module === "mongoose") return mongooseStub(rt);
  if (module.startsWith("@aws-sdk/")) return awsStub(rt, module);
  if (module === "express") return expressStub(rt);
  if (module === "fastify") return fastifyStub(rt);
  if (module === "bullmq" || module === "bull") return queueStub(rt, module);
  if (module === "stripe") {
    return keyedStub(rt, module, (_c, args) => (args[1] as { idempotencyKey?: string })?.idempotencyKey, (chain, args) => {
      const op = chain[chain.length - 1];
      if (op === "constructEvent") return parseBody(args[0]);
      if (op === "constructEventAsync") return Promise.resolve(parseBody(args[0]));
      return DEFAULT;
    });
  }
  if (module === "resend") return keyedStub(rt, module, (_c, args) => (args[1] as { idempotencyKey?: string })?.idempotencyKey);
  if (["svix", "standardwebhooks", "@octokit/webhooks", "@shopify/shopify-api"].includes(module)) return verifierStub(rt, module);
  if (module === "sqs-consumer") {
    return proxy(rt, module, [], (chain, args) => {
      if (chain[chain.length - 1] !== "create") return DEFAULT;
      const o = args[0] as Record<string, unknown>;
      rt.registrations.push({ kind: "worker", framework: "sqs-consumer", path: "sqs", owner: {}, handlers: [o.handleMessage ?? o.handleMessageBatch] });
      return { start() {}, stop() {}, on() {} };
    });
  }
  if (module === "next/server") {
    const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);
    // biome-ignore lint/complexity/useArrowFunction: NextResponse is also used with `new`
    return { NextResponse: Object.assign(function () {}, { json, next: () => new Response(null), redirect: (u: string) => Response.redirect(u) }), after: (fn: () => unknown) => fn(), __esModule: true };
  }
  if (module === "next/headers") return { headers: async () => rt.currentHeaders, cookies: async () => ({ get: () => undefined }), __esModule: true };
  if (["uuid", "nanoid", "cuid", "@paralleldrive/cuid2", "ulid"].includes(module)) {
    return new Proxy(/* biome-ignore lint/complexity/useArrowFunction: Proxy targets must be constructible */ function () {} as unknown as object, { get: (_t, p) => (p === "__esModule" ? true : p === "then" ? undefined : random), apply: random });
  }
  return proxy(rt, module, []);
}

export type { Registration };
