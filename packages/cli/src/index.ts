import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyze, type Confidence } from "@retrysafe/core";
import { renderMarkdown } from "./markdown";
import { renderTerminal } from "./terminal";

const HELP = `Usage: retrysafe [dir] [options]

Find webhook and queue handlers that double-charge, double-email, or drop events on retry.

Options:
  --handlers               List discovered at-least-once handlers only
  --effect-map             Show the effect map for every handler, not just flagged ones
  --format <fmt>           terminal (default), json, or markdown
  --project <tsconfig>     Path to tsconfig.json (default: <dir>/tsconfig.json)
  --max-depth <n>          Call depth to follow into your own code (default: 6)
  --min-confidence <lvl>   low, medium (default), or high
  --ci                     Exit 1 when any error-severity finding is reported
  -h, --help               Show this help
`;

function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      handlers: { type: "boolean" },
      "effect-map": { type: "boolean" },
      format: { type: "string", default: "terminal" },
      project: { type: "string" },
      "max-depth": { type: "string" },
      "min-confidence": { type: "string" },
      ci: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const root = path.resolve(positionals[0] ?? ".");
  if (!existsSync(root)) {
    process.stderr.write(`retrysafe: no such directory: ${root}\n`);
    return 2;
  }
  const minConfidence = values["min-confidence"] as Confidence | undefined;
  if (minConfidence && !["low", "medium", "high"].includes(minConfidence)) {
    process.stderr.write(`retrysafe: --min-confidence must be low, medium, or high\n`);
    return 2;
  }
  if (!["terminal", "json", "markdown"].includes(values.format ?? "")) {
    process.stderr.write(`retrysafe: --format must be terminal, json, or markdown\n`);
    return 2;
  }

  const result = analyze({
    root,
    tsconfig: values.project,
    maxCallDepth: values["max-depth"] ? Number(values["max-depth"]) : undefined,
    minConfidence,
  });

  if (values.format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (values.format === "markdown") {
    process.stdout.write(renderMarkdown(result));
  } else {
    process.stdout.write(`${renderTerminal(result, { handlersOnly: values.handlers, allEffectMaps: values["effect-map"] })}\n`);
  }

  return values.ci && result.findings.some((f) => f.severity === "error") ? 1 : 0;
}

process.exitCode = main();
