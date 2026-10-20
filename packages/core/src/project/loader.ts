import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { Project, ts, type SourceFile } from "ts-morph";

export interface LoadedProject {
  project: Project;
  root: string;
  /** Project source files, excluding declaration files and node_modules. */
  sourceFiles: SourceFile[];
}

const DEFAULT_GLOBS = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", "!**/node_modules/**", "!**/dist/**", "!**/.next/**"];

/**
 * Load a TypeScript/JavaScript project from disk. Uses the root tsconfig.json when present
 * (so path aliases resolve), otherwise falls back to permissive defaults over all source files.
 */
export function loadProject(root: string, tsconfigPath?: string): LoadedProject {
  // realpath: on case-insensitive file systems a differently-cased path would make every glob miss.
  const absRoot = realpathSync.native(path.resolve(root));
  const configPath = tsconfigPath ? path.resolve(tsconfigPath) : path.join(absRoot, "tsconfig.json");

  let project: Project;
  if (existsSync(configPath)) {
    project = new Project({ tsConfigFilePath: configPath, compilerOptions: { allowJs: true } });
  } else {
    project = new Project({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.Preserve,
        esModuleInterop: true,
      },
    });
    project.addSourceFilesAtPaths(DEFAULT_GLOBS.map((g) => (g.startsWith("!") ? `!${path.join(absRoot, g.slice(1))}` : path.join(absRoot, g))));
  }

  return { project, root: absRoot, sourceFiles: projectSourceFiles(project) };
}

/** Wrap an existing (e.g. in-memory) ts-morph project. */
export function fromProject(project: Project, root = "/"): LoadedProject {
  return { project, root: path.resolve(root), sourceFiles: projectSourceFiles(project) };
}

export function projectSourceFiles(project: Project): SourceFile[] {
  return project.getSourceFiles().filter((sf) => !sf.isDeclarationFile() && !sf.isInNodeModules());
}
