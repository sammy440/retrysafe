import path from "node:path";
import type { LoadedProject } from "../project/loader";
import { functionFromDeclaration } from "../project/resolve";
import type { Candidate } from "./types";

export class HandlerConfigError extends Error {}

/** Handlers listed in config as "path/to/file.ts#exportName" (or "#default"). */
export function discoverConfigured(loaded: LoadedProject, entries: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const entry of entries) {
    const [file, exportName = "default"] = entry.split("#");
    const sf = loaded.project.getSourceFile(path.resolve(loaded.root, file ?? ""));
    if (!sf) throw new HandlerConfigError(`handlers.add: file not found in project: ${file}`);
    const decl = sf.getExportedDeclarations().get(exportName)?.[0];
    const fn = decl && functionFromDeclaration(decl);
    if (!fn) throw new HandlerConfigError(`handlers.add: ${file} has no exported function "${exportName}"`);
    out.push({
      kind: "serverless",
      framework: "config",
      name: entry,
      fn,
      anchor: fn,
      signals: ["config"],
      alwaysAtLeastOnce: true,
    });
  }
  return out;
}
