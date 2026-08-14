import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("G112 release gate", () => {
  it("fails unfinished releases and only permits an explicit development override", () => {
    const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const script = join(process.cwd(), "scripts", "g112-release-gate.ts");
    const blocked = spawnSync(process.execPath, [tsx, script], { encoding: "utf8" });
    expect(blocked.status).not.toBe(0);
    const override = spawnSync(process.execPath, [tsx, script, "--allow-incomplete"], { encoding: "utf8" });
    expect(override.status).toBe(0);
    expect(`${override.stdout}\n${override.stderr}`).toContain("incomplete override");
    expect(`${blocked.stdout}\n${blocked.stderr}`).toContain("G112-REPORT.md is not complete");
  }, 30_000);
});
