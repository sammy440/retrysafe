import type { Handler } from "@retrysafe/core";
import type { Registration, VerifyRuntime } from "./runtime";

export interface Delivery {
  payload: unknown;
  headers: Record<string, string>;
}

export interface DeliveryResult {
  status?: number;
  error?: string;
}

type Fn = (...args: unknown[]) => unknown;

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

function joinPath(...parts: string[]): string {
  return `/${parts.join("/").split("/").filter(Boolean).join("/")}`;
}

function nodeStyle(d: Delivery, url: string) {
  let resolve!: (status: number) => void;
  const done = new Promise<number>((r) => (resolve = r));
  const body = d.payload;
  const req = {
    body,
    rawBody: Buffer.from(JSON.stringify(body)),
    headers: Object.fromEntries(Object.entries(d.headers).map(([k, v]) => [k.toLowerCase(), v])),
    method: "POST",
    url,
    originalUrl: url,
    path: url,
    params: {},
    query: {},
    get: (h: string) => d.headers[h] ?? d.headers[h.toLowerCase()],
    header: (h: string) => d.headers[h] ?? d.headers[h.toLowerCase()],
  };
  const res: Record<string, unknown> = { statusCode: 200, locals: {}, headersSent: false };
  const end = () => {
    res.headersSent = true;
    resolve(res.statusCode as number);
    return res;
  };
  const setStatus = (n: number) => {
    res.statusCode = n;
    return res;
  };
  Object.assign(res, {
    status: setStatus,
    code: setStatus,
    sendStatus: (n: number) => {
      setStatus(n);
      return end();
    },
    json: end,
    send: end,
    end,
    redirect: () => {
      setStatus(302);
      return end();
    },
    set: () => res,
    header: () => res,
    setHeader: () => res,
    type: () => res,
  });
  return { req, res, done };
}

async function runChain(fns: Fn[], req: unknown, res: unknown): Promise<void> {
  let i = 0;
  const next = async (err?: unknown): Promise<void> => {
    if (err) throw err;
    const fn = fns[i++];
    if (fn) await fn(req, res, next);
  };
  await next();
}

function expressRoute(rt: VerifyRuntime, name: string): { fns: Fn[]; path: string } | undefined {
  const regs = rt.registrations.filter((r) => r.framework === "express");
  const prefixOf = (owner: object, seen = new Set<object>()): string => {
    if (seen.has(owner)) return "";
    seen.add(owner);
    const mount = regs.find((r) => r.kind === "use" && r.handlers.includes(owner));
    return mount ? joinPath(prefixOf(mount.owner, seen), mount.path ?? "") : "";
  };
  for (const r of regs) {
    if (r.kind !== "route") continue;
    const full = joinPath(prefixOf(r.owner), r.path ?? "");
    if (`${r.method!.toUpperCase()} ${full}` !== name) continue;
    const owners = new Set<object>([r.owner]);
    for (let o: object | undefined = r.owner; o; ) {
      const mount = regs.find((m) => m.kind === "use" && m.handlers.includes(o!));
      o = mount?.owner;
      if (o) owners.add(o);
    }
    const uses = regs
      .filter((u) => u.kind === "use" && owners.has(u.owner) && u.path !== undefined && full.startsWith(joinPath(u.path)))
      .flatMap((u) => u.handlers.filter((h): h is Fn => typeof h === "function" && !regs.some((x) => x.owner === h)));
    return { fns: [...uses, ...(r.handlers.filter((h) => typeof h === "function") as Fn[])], path: full };
  }
  return undefined;
}

function findRoute(rt: VerifyRuntime, framework: string, name: string): Registration | undefined {
  return rt.registrations.find((r) => r.kind === "route" && r.framework === framework && `${r.method!.toUpperCase()} ${r.path}` === name);
}

export async function deliver(handler: Handler, mod: Record<string, unknown>, rt: VerifyRuntime, d: Delivery, run: number): Promise<DeliveryResult> {
  rt.currentHeaders = new Headers(d.headers);
  const name = handler.name;
  try {
    switch (handler.framework) {
      case "express": {
        const route = expressRoute(rt, name);
        if (!route) return { error: `route ${name} was not registered when the module loaded` };
        const { req, res, done } = nodeStyle(d, route.path);
        await runChain(route.fns, req, res);
        return { status: await Promise.race([done, settle(50).then(() => 200)]) };
      }
      case "fastify": {
        await (globalThis as { __retrysafeFastifyReady?: () => Promise<unknown> }).__retrysafeFastifyReady?.();
        const r = findRoute(rt, "fastify", name);
        if (!r) return { error: `route ${name} was not registered` };
        const { req, res, done } = nodeStyle(d, r.path!);
        const fns = r.handlers.filter((h) => typeof h === "function") as Fn[];
        let returned: unknown;
        for (const fn of fns) returned = await fn(req, res);
        return { status: returned !== undefined ? (res.statusCode as number) : await Promise.race([done, settle(50).then(() => res.statusCode as number)]) };
      }
      case "next-app-router": {
        const [method, path] = name.split(" ");
        const fn = mod[method!] as Fn;
        const response = (await fn(
          new Request(`http://localhost${path}`, { method, body: JSON.stringify(d.payload), headers: { "content-type": "application/json", ...d.headers } }),
          { params: Promise.resolve({}) },
        )) as Response | undefined;
        return { status: response?.status ?? 200 };
      }
      case "next-pages-api": {
        const { req, res, done } = nodeStyle(d, name.split(" ")[1]!);
        await (mod.default as Fn)(req, res);
        return { status: await Promise.race([done, settle(50).then(() => 200)]) };
      }
      case "bullmq":
      case "bull":
      case "sqs-consumer": {
        const queue = name.match(/queue "([^"]+)"/)?.[1];
        const w = rt.registrations.find((r) => r.kind === "worker" && r.framework === handler.framework && (!queue || r.path === queue));
        if (!w) return { error: `worker for ${name} was not registered` };
        const job =
          handler.framework === "sqs-consumer"
            ? { MessageId: "msg_retrysafe_1", Body: JSON.stringify(d.payload) }
            : { id: "job_retrysafe_1", name: queue, data: d.payload, attemptsMade: run - 1, updateProgress: async () => {}, log: async () => {} };
        await (w.handlers[0] as Fn)(job);
        return { status: 200 };
      }
      case "aws-lambda": {
        const exportName = name.match(/#(\w+)/)?.[1] ?? "handler";
        const p = d.payload as { Records?: unknown[] };
        const event = p?.Records ? p : { Records: [{ messageId: "msg_retrysafe_1", body: JSON.stringify(d.payload), eventSource: "aws:sqs" }] };
        const out = (await (mod[exportName] as Fn)(event, { awsRequestId: `req_${run}` })) as { statusCode?: number; batchItemFailures?: unknown[] } | undefined;
        return { status: out?.batchItemFailures?.length ? 500 : (out?.statusCode ?? 200) };
      }
      case "probot": {
        const event = name.replace(/^Probot on /, "").split(",")[0]!.trim();
        const handlers: Fn[] = [];
        const app = { on: (e: string | string[], fn: Fn) => [e].flat().some((x) => x === event || event.startsWith(`${x}.`)) && handlers.push(fn), log: { info() {}, error() {} } };
        await (mod.default as Fn)(app);
        const ctx = { id: "delivery_retrysafe_1", name: event, payload: d.payload, octokit: (globalThis.__retrysafeVerify!.stub("probot") as Record<string, unknown>).octokit, issue: (o: object) => ({ owner: "o", repo: "r", issue_number: 1, ...o }), repo: (o: object) => ({ owner: "o", repo: "r", ...o }), log: { info() {} } };
        for (const h of handlers) await h(ctx);
        return { status: 200 };
      }
      default: {
        const exportName = name.match(/#(\w+)/)?.[1] ?? "default";
        await (mod[exportName] as Fn)(d.payload);
        return { status: 200 };
      }
    }
  } catch (err) {
    return { status: 500, error: (err as Error)?.message ?? String(err) };
  }
}
