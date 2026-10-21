import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  analyzeLoaded,
  applyBaseline,
  DEFAULT_BASELINE,
  loadProjects,
  mergeResults,
  optionsFromConfig,
  parseBaseline,
  projectSourceFiles,
  type AnalysisResult,
  type AnalyzeOptions,
  type LoadedProject,
  type RetrysafeConfig,
} from "@retrysafe/core";
import { findConfig, loadConfig } from "../load-config";

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** Changes to these rebuild the whole project instead of refreshing files. */
const STRUCTURAL = /(^|\/)(tsconfig[^/]*\.json|package\.json|retrysafe\.config\.[^/]+|\.retrysafe-baseline\.json|[^/]+\.prisma|[^/]+\.sql|pnpm-workspace\.yaml)$/;

export interface Excerpt {
  startLine: number;
  lines: string[];
}

export interface LiveResult {
  result: AnalysisResult & { findings: (AnalysisResult["findings"][number] & { excerpt?: Excerpt })[] };
  durationMs: number;
  changedFiles: string[];
  at: number;
}

/**
 * A project kept in memory between analyses: file changes refresh only the affected source files, so
 * re-analysis after a save skips loading and parsing everything again.
 */
export class LiveSession {
  private projects: LoadedProject[] = [];
  private config: RetrysafeConfig = {};
  private options: AnalyzeOptions = {};

  constructor(
    readonly root: string,
    private readonly overrides: { tsconfig?: string; configPath?: string } = {},
  ) {}

  async load(): Promise<void> {
    const configPath = this.overrides.configPath ?? findConfig(this.root);
    this.config = configPath ? await loadConfig(configPath) : {};
    this.options = optionsFromConfig(this.config);
    this.projects = loadProjects(this.root, this.overrides.tsconfig);
  }

  /** Apply file changes (relative paths). Returns true if the project had to be reloaded. */
  async apply(changed: string[]): Promise<boolean> {
    if (changed.some((f) => STRUCTURAL.test(f))) {
      await this.load();
      return true;
    }
    for (const rel of changed) {
      const abs = path.join(this.root, rel);
      if (!SOURCE.test(abs)) continue;
      const exists = existsSync(abs);
      let known = false;
      for (const p of this.projects) {
        const sf = p.project.getSourceFile(abs);
        if (!sf) continue;
        known = true;
        if (exists) sf.refreshFromFileSystemSync();
        else p.project.removeSourceFile(sf);
      }
      // A new file joins the project whose tsconfig directory contains it most closely.
      if (!known && exists) {
        const dirOf = (p: LoadedProject) => {
          const cfg = p.project.getCompilerOptions().configFilePath as string | undefined;
          return cfg ? path.dirname(cfg) : p.root;
        };
        const owner = this.projects
          .filter((p) => abs.startsWith(`${dirOf(p)}${path.sep}`))
          .sort((a, b) => dirOf(b).length - dirOf(a).length)[0] ?? this.projects[0];
        owner?.project.addSourceFileAtPathIfExists(abs);
      }
    }
    for (const p of this.projects) p.sourceFiles = projectSourceFiles(p.project);
    return false;
  }

  analyze(changedFiles: string[] = []): LiveResult {
    const started = Date.now();
    let result = mergeResults(this.projects.map((p) => analyzeLoaded(p, this.options)));
    const baselinePath = path.resolve(this.root, this.config.baseline ?? DEFAULT_BASELINE);
    if (existsSync(baselinePath)) result = applyBaseline(result, parseBaseline(readFileSync(baselinePath, "utf8")));
    // Excerpts on both the flat list and each handler's findings (the browser renders per handler).
    const withExcerpt = <F extends AnalysisResult["findings"][number]>(f: F) => ({ ...f, excerpt: this.excerpt(f.location.file, f.location.line) });
    const withExcerpts = {
      ...result,
      findings: result.findings.map(withExcerpt),
      handlers: result.handlers.map((h) => ({ ...h, findings: h.findings.map(withExcerpt) })),
    };
    return { result: withExcerpts, durationMs: Date.now() - started, changedFiles, at: Date.now() };
  }

  /** A few lines around a finding, for showing it without opening the file. */
  private excerpt(file: string, line: number): Excerpt | undefined {
    const abs = path.join(this.root, file);
    const sf = this.projects.map((p) => p.project.getSourceFile(abs)).find(Boolean);
    const text = sf?.getFullText() ?? (existsSync(abs) ? readFileSync(abs, "utf8") : undefined);
    if (!text) return undefined;
    const all = text.split("\n");
    const startLine = Math.max(1, line - 3);
    return { startLine, lines: all.slice(startLine - 1, Math.min(all.length, line + 3)) };
  }
}
