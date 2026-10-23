import { RULES, type AnalysisResult, type Finding, type Severity } from "@retrysafe/core";

const LEVEL: Record<Severity, "error" | "warning" | "note"> = { error: "error", warning: "warning", info: "note" };
const DOCS = "https://github.com/sammy440/retrysafe/blob/main/README-retrysafe.md#rule-catalog";

function text(f: Finding): string {
  return [f.message, "", "Failing sequence:", ...f.failingSequence.map((s, i) => `${i + 1}. ${s}`), "", `Fix: ${f.fix}`].join("\n");
}

export function renderSarif(result: AnalysisResult, version: string): string {
  const handlerName = new Map(result.handlers.map((h) => [h.handler.id, h.handler.name]));
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "retrysafe",
            version,
            informationUri: "https://github.com/sammy440/retrysafe",
            rules: RULES.map((r) => ({
              id: r.id,
              shortDescription: { text: r.docs.summary },
              fullDescription: { text: `${r.docs.why} ${r.docs.safePattern}` },
              help: { text: r.docs.safePattern },
              helpUri: DOCS,
              defaultConfiguration: { level: LEVEL[r.severity] },
            })),
          },
        },
        results: result.findings.map((f) => ({
          ruleId: f.rule,
          level: LEVEL[f.severity],
          message: { text: text(f) },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.location.file, uriBaseId: "%SRCROOT%" },
                region: { startLine: f.location.line, startColumn: f.location.column },
              },
              message: { text: handlerName.get(f.handler) ?? f.handler },
            },
          ],
          partialFingerprints: { "retrysafe/v1": f.id },
          properties: { confidence: f.confidence, handler: handlerName.get(f.handler) },
          ...(f.effect?.path.length
            ? {
                codeFlows: [
                  {
                    threadFlows: [
                      {
                        locations: [...f.effect.path, f.effect.location].map((l) => ({
                          location: {
                            physicalLocation: {
                              artifactLocation: { uri: l.file, uriBaseId: "%SRCROOT%" },
                              region: { startLine: l.line, startColumn: l.column },
                            },
                          },
                        })),
                      },
                    ],
                  },
                ],
              }
            : {}),
        })),
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}
