import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("release inventory", () => {
  it("emits SBOM, runtime, notices and sanitized build metadata", () => {
    execFileSync(process.execPath, [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/release/release-inventory.ts"], {
      cwd: process.cwd(),
      stdio: "ignore",
      windowsHide: true,
    });
    const directory = join(process.cwd(), "dist", "release-inventory");
    expect(existsSync(join(directory, "runtime-manifest.json"))).toBe(true);
    expect(existsSync(join(directory, "THIRD_PARTY_NOTICES.txt"))).toBe(true);
    const sbom = JSON.parse(readFileSync(join(directory, "sbom.cdx.json"), "utf8")) as {
      specVersion?: string;
      components?: readonly { name?: string; type?: string }[];
    };
    const metadata = readFileSync(join(directory, "build-metadata.json"), "utf8");
    expect(sbom.specVersion).toBe("1.5");
    expect(sbom.components?.some((component) => component.name === "qx-runtime-jre" && component.type === "file")).toBe(true);
    expect(sbom.components?.length).toBeGreaterThan(500);
    expect(metadata).not.toContain("PYTHONPATH");
    expect(metadata).not.toContain("JAVA_HOME");
  });
});
