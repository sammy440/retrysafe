import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync, watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { LiveSession, type LiveResult } from "./session";

const WATCHED = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|prisma|sql|yaml)$/;
const IGNORED = /(^|\/)(node_modules|\.git|dist|build|\.next|\.turbo|coverage|\.retrysafe-cache)(\/|$)/;

export interface LiveOptions {
  root: string;
  port: number;
  /** Browser origins allowed to connect (the retrysafe site). */
  origins: string[];
  tsconfig?: string;
  configPath?: string;
  debounceMs?: number;
  log?: (msg: string) => void;
  /** Reuse a token (so an open page reconnects after a restart); a random one is made otherwise. */
  token?: string;
}

export type LiveMessage =
  | { type: "hello"; root: string; name: string; version: number }
  | { type: "analyzing"; changedFiles: string[] }
  | ({ type: "result" } & LiveResult)
  | { type: "error"; message: string };

export interface LiveServer {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Serves live analysis of a project to the retrysafe site over a WebSocket on 127.0.0.1. Only the
 * configured origins, presenting the random token printed in the terminal, may connect; nothing is
 * exposed beyond the local machine.
 */
export async function startLiveServer(opts: LiveOptions): Promise<LiveServer> {
  const log = opts.log ?? (() => {});
  // The loader works on real paths; watch and resolve against the same one (macOS /var -> /private/var).
  opts = { ...opts, root: realpathSync.native(opts.root) };
  const token = opts.token ?? randomBytes(18).toString("base64url");
  const session = new LiveSession(opts.root, { tsconfig: opts.tsconfig, configPath: opts.configPath });
  await session.load();

  let latest: LiveResult | undefined;
  let lastError: string | undefined;
  const clients = new Set<WebSocket>();
  const send = (ws: WebSocket, msg: LiveMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: LiveMessage) => {
    for (const c of clients) send(c, msg);
  };

  const run = (changed: string[]) => {
    try {
      latest = session.analyze(changed);
      lastError = undefined;
      broadcast({ type: "result", ...latest });
      const n = latest.result.findings.length;
      log(`analyzed ${latest.result.handlers.length} handler(s), ${n} finding(s) in ${latest.durationMs} ms${changed.length ? ` (changed: ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? "…" : ""})` : ""}`);
    } catch (err) {
      lastError = (err as Error).message;
      broadcast({ type: "error", message: lastError });
      log(`analysis failed: ${lastError}`);
    }
  };
  run([]);

  // Debounced re-analysis: editors often write a file several times per save.
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = Promise.resolve();
  const flush = () => {
    const changed = [...pending];
    pending.clear();
    busy = busy.then(async () => {
      broadcast({ type: "analyzing", changedFiles: changed });
      try {
        await session.apply(changed);
      } catch (err) {
        broadcast({ type: "error", message: (err as Error).message });
        return;
      }
      run(changed);
    });
  };
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(opts.root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString().split(path.sep).join("/");
      if (IGNORED.test(rel) || !WATCHED.test(rel)) return;
      pending.add(rel);
      clearTimeout(timer);
      timer = setTimeout(flush, opts.debounceMs ?? 150);
    });
  } catch (err) {
    log(`file watching is unavailable (${(err as Error).message}); results will not update on save`);
  }

  const allowed = new Set(opts.origins.map((o) => o.replace(/\/$/, "")));
  const originOk = (origin: string | undefined) => !!origin && allowed.has(origin.replace(/\/$/, ""));

  const http: Server = createServer((req, res) => {
    const origin = req.headers.origin;
    if (originOk(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin!);
      res.setHeader("Vary", "Origin");
      // Chrome's Private Network Access preflight for pages reaching localhost.
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "content-type" }).end();
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, name: path.basename(opts.root) }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  http.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const given = url.searchParams.get("token") ?? "";
    if (url.pathname !== "/live" || !originOk(req.headers.origin) || !sameToken(given, token)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      // Clients only listen; anything they send is ignored.
      send(ws, { type: "hello", root: opts.root, name: path.basename(opts.root), version: 1 });
      if (latest) send(ws, { type: "result", ...latest });
      else if (lastError) send(ws, { type: "error", message: lastError });
      log(`browser connected (${clients.size} open)`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, "127.0.0.1", () => resolve());
  });
  const port = (http.address() as { port: number }).port;

  return {
    url: `ws://127.0.0.1:${port}/live`,
    token,
    port,
    async close() {
      clearTimeout(timer);
      watcher?.close();
      for (const c of clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
