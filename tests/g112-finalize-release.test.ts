import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const evidence = [
  ["tauri-clean-win11-e2e.json", "tauri-clean-win11-e2e"],
  ["tauri-upgrade-win11-e2e.json", "tauri-upgrade-win11-e2e"],
  ["tauri-hls-20s-e2e.json", "tauri-hls-20s-e2e"],
  ["tauri-components-release.json", "tauri-components-release"],
  ["tauri-signature.json", "tauri-signature"],
] as const;

describe("G112 release finalization", () => {
  it("refuses to finalize when any verified evidence is missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-g112-finalize-missing-"));
    try {
      writeFileSync(join(directory, "tauri-signature.json"), JSON.stringify({ schemaVersion: "v1", verified: true, evidenceType: "tauri-signature" }));
      const result = run(directory, join(directory, "G112-REPORT.md"));
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("missing release evidence");
      expect(existsSync(join(directory, "G112-REPORT.md"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes a complete report only after every evidence record is verified", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-g112-finalize-complete-"));
    try {
      for (const [fileName, evidenceType] of evidence) {
        writeFileSync(join(directory, fileName), JSON.stringify({ schemaVersion: "v1", verified: true, evidenceType }));
      }
      const report = join(directory, "G112-REPORT.md");
      const result = run(directory, report);
      expect(result.status).toBe(0);
      expect(readFileSync(report, "utf8")).toContain("Status: complete");
      expect(readFileSync(report, "utf8")).toContain("tauri-components-release.json");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function run(evidenceDirectory: string, report: string) {
  return spawnSync(process.execPath, [
    join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
    "scripts/finalize-g112-release.ts",
    "--evidence-dir", evidenceDirectory,
    "--report", report,
  ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
}
