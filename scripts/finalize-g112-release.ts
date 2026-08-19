import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const evidenceDirectory = resolve(projectRoot, args["evidence-dir"] ?? "artifacts");
const reportPath = resolve(projectRoot, args.report ?? "docs/reports/goals/G112-REPORT.md");

const requiredEvidence = [
  ["tauri-clean-win11-e2e.json", "tauri-clean-win11-e2e"],
  ["tauri-upgrade-win11-e2e.json", "tauri-upgrade-win11-e2e"],
  ["tauri-hls-20s-e2e.json", "tauri-hls-20s-e2e"],
  ["tauri-components-release.json", "tauri-components-release"],
  ["tauri-signature.json", "tauri-signature"],
] as const;

for (const [fileName, evidenceType] of requiredEvidence) {
  const path = resolve(evidenceDirectory, fileName);
  if (!existsSync(path)) throw new Error(`missing release evidence: ${path}`);
  const value = readJson(path);
  if (value.schemaVersion !== "v1" || value.verified !== true || value.evidenceType !== evidenceType) {
    throw new Error(`release evidence is not verified: ${path}`);
  }
}

writeFileSync(reportPath, [
  "# G112 signed release completion report",
  "",
  "Status: complete",
  "",
  "This report is generated only after the signed component, Authenticode, clean Win11, upgrade, and real HLS evidence files have all been produced and marked verified.",
  "",
  "Evidence:",
  ...requiredEvidence.map(([fileName]) => `- artifacts/${fileName}`),
  "",
  "The source-tree G112 progress report remains blocked until this release job has real external evidence. This CI copy is the final release-gate input.",
  "",
].join("\n"), "utf8");
console.log(`G112 release report finalized: ${reportPath}`);

function parseArgs(values: string[]): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value?.startsWith("--")) throw new Error(`unexpected argument: ${value ?? ""}`);
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`missing value for ${value}`);
    result[key] = next;
    index += 1;
  }
  return result;
}

function readJson(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`release evidence must be an object: ${path}`);
  }
  return value as Record<string, unknown>;
}
