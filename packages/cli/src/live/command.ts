import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { startLiveServer } from "./server";

export interface LiveCommandOptions {
  root: string;
  port: number;
  site?: string;
  origins: string[];
  open: boolean;
  tsconfig?: string;
  configPath?: string;
  newToken?: boolean;
}

/**
 * The token for a project, kept in a user-only file so restarting `retrysafe live` keeps the same link
 * and an open page reconnects by itself. `--new-token` rotates it.
 */
function projectToken(root: string, rotate: boolean): string {
  const dir = path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), "retrysafe", "live");
  const file = path.join(dir, `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.token`);
  if (!rotate && existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (/^[\w-]{20,}$/.test(saved)) return saved;
  }
  const token = randomBytes(18).toString("base64url");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, token, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // Not persisted: the link just changes on the next start.
  }
  return token;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(cmd as string, args as string[], () => {});
}

const time = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** `retrysafe live`: analyze, watch, and stream results to the site until interrupted. */
export async function runLive(opts: LiveCommandOptions): Promise<number> {
  const site = (opts.site ?? process.env.RETRYSAFE_SITE_URL ?? "https://retrysafe-frontend.vercel.app").replace(/\/$/, "");
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error("--port must be a port number");
  const siteOrigin = new URL(site).origin;
  process.stdout.write(`retrysafe live: analyzing ${opts.root}…\n`);
  const server = await startLiveServer({
    root: opts.root,
    port: opts.port,
    origins: [siteOrigin, ...opts.origins],
    tsconfig: opts.tsconfig,
    configPath: opts.configPath,
    token: projectToken(opts.root, !!opts.newToken),
    log: (m) => process.stdout.write(`  ${time()}  ${m}\n`),
  });
  const link = `${site}/live#port=${server.port}&token=${server.token}`;
  process.stdout.write(
    [
      "",
      "  Open this link to see results update as you save:",
      `  ${link}`,
      "",
      `  Serving on 127.0.0.1:${server.port} to ${siteOrigin} only. Your code stays on this machine.`,
      "  Press Ctrl+C to stop.",
      "",
    ].join("\n"),
  );
  if (opts.open) openBrowser(link);

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await server.close();
  process.stdout.write("\nretrysafe live: stopped\n");
  return 0;
}
