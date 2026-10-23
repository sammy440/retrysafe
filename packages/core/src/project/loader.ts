import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { Project, ts, type SourceFile } from "ts-morph";
import { tsconfigReferences, workspacePackages } from "./workspace";

export interface LoadedProject {
  project: Project;
  root: string;
  sourceFiles: SourceFile[];
}

const DEFAULT_GLOBS = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", "!**/node_modules/**", "!**/dist/**", "!**/.next/**"];

const COMPILER_DEFAULTS = {
  allowJs: true,
  checkJs: false,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  esModuleInterop: true,
};

function withGlobs(dir: string): Project {
  const project = new Project({ compilerOptions: COMPILER_DEFAULTS });
  project.addSourceFilesAtPaths(DEFAULT_GLOBS.map((g) => (g.startsWith("!") ? `!${path.join(dir, g.slice(1))}` : path.join(dir, g))));
  return project;
}

function withTsconfig(configPath: string): Project {
  return new Project({ tsConfigFilePath: configPath, compilerOptions: { allowJs: true } });
}

export function loadProject(root: string, tsconfigPath?: string): LoadedProject {
  const absRoot = realpathSync.native(path.resolve(root));
  const configPath = tsconfigPath ? path.resolve(tsconfigPath) : path.join(absRoot, "tsconfig.json");
  const project = existsSync(configPath) ? withTsconfig(configPath) : withGlobs(absRoot);
  return { project, root: absRoot, sourceFiles: projectSourceFiles(project) };
}

export function loadProjects(root: string, tsconfigPath?: string): LoadedProject[] {
  const absRoot = realpathSync.native(path.resolve(root));
  if (tsconfigPath) return [loadProject(absRoot, tsconfigPath)];

  const rootConfig = path.join(absRoot, "tsconfig.json");
  if (existsSync(rootConfig)) {
    const single = loadProject(absRoot);
    if (single.sourceFiles.length > 0) return [single];
  }

  const configs = new Set(existsSync(rootConfig) ? tsconfigReferences(rootConfig).filter(existsSync) : []);
  const globDirs: string[] = [];
  for (const dir of workspacePackages(absRoot)) {
    const cfg = path.join(dir, "tsconfig.json");
    if (existsSync(cfg)) configs.add(cfg);
    else globDirs.push(dir);
  }
  const loaded = [...[...configs].map(withTsconfig), ...globDirs.map(withGlobs)].map((project) => ({
    project,
    root: absRoot,
    sourceFiles: projectSourceFiles(project),
  }));
  return loaded.length ? loaded : [loadProject(absRoot)];
}

export function fromProject(project: Project, root = "/"): LoadedProject {
  return { project, root: path.resolve(root), sourceFiles: projectSourceFiles(project) };
}

export function projectSourceFiles(project: Project): SourceFile[] {
  return project.getSourceFiles().filter((sf) => !sf.isDeclarationFile() && !sf.isInNodeModules());
}
