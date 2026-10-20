import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyze } from "../src";

const FIXTURES = path.resolve(__dirname, "../../../fixtures");

/** Collect `// expect: <rule>` markers as "rule file:line". */
function expectedFindings(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "node_modules") visit(full);
        continue;
      }
      if (!/\.[cm]?[jt]sx?$/.test(name)) continue;
      readFileSync(full, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const m of line.matchAll(/\/\/ expect: ([\w-]+(?:\s*,\s*[\w-]+)*)/g)) {
            for (const rule of m[1]!.split(",")) {
              out.push(`${rule.trim()} ${path.relative(root, full).split(path.sep).join("/")}:${i + 1}`);
            }
          }
        });
    }
  };
  visit(root);
  return [...new Set(out)].sort();
}

const fixtures = readdirSync(FIXTURES).filter((d) => statSync(path.join(FIXTURES, d)).isDirectory());

describe.each(fixtures)("fixture %s", (name) => {
  const root = path.join(FIXTURES, name);
  const expected = JSON.parse(readFileSync(path.join(root, "expected.json"), "utf8")) as { handlers: string[] };
  const result = analyze({ root });

  it("discovers exactly the at-least-once handlers", () => {
    expect(result.handlers.map((h) => h.handler.name).sort()).toEqual([...expected.handlers].sort());
  });

  it("reports exactly the marked findings", () => {
    const actual = [...new Set(result.findings.map((f) => `${f.rule} ${f.location.file}:${f.location.line}`))].sort();
    expect(actual).toEqual(expectedFindings(root));
  });
});
