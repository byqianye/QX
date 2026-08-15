import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Tauri release evidence", () => {
  it("refuses to write release evidence when Authenticode is not valid", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-tauri-evidence-test-"));
    try {
      const artifact = Buffer.from("component-fixture");
      const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
      const quickJsArtifact = Buffer.from("quickjs-fixture");
      const quickJsSha256 = createHash("sha256").update(quickJsArtifact).digest("hex");
      const manifest = Buffer.from(`{"version":1,"components":[{"id":"mpv","version":"1","target":"x86_64-pc-windows-msvc","sha256":"${artifactSha256}","url":"https://example.test/component.bin"},{"id":"quickjs","version":"1","target":"x86_64-pc-windows-msvc","sha256":"${quickJsSha256}","url":"https://example.test/quickjs.bin"}]}`);
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
      const signature = sign(null, manifest, privateKey);
      const installer = join(directory, "installer.exe");
      const manifestPath = join(directory, "manifest.json");
      const signaturePath = join(directory, "manifest.sig.b64");
      const publicKeyPath = join(directory, "manifest.pub.b64");
      const artifactPath = join(directory, "component.bin");
      const quickJsArtifactPath = join(directory, "quickjs.bin");
      const output = join(directory, "out");
      writeFileSync(installer, "not-a-signed-pe");
      writeFileSync(manifestPath, manifest);
      writeFileSync(signaturePath, signature.toString("base64"));
      writeFileSync(publicKeyPath, publicKeyDer.subarray(publicKeyDer.length - 32).toString("base64"));
      writeFileSync(artifactPath, artifact);
      writeFileSync(quickJsArtifactPath, quickJsArtifact);

      const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/tauri-release-evidence.ts",
        "--installer", installer,
        "--component-manifest", manifestPath,
        "--component-signature", signaturePath,
        "--component-public-key", publicKeyPath,
        "--component-artifact", `${artifactPath},${quickJsArtifactPath}`,
        "--component-id", "mpv,quickjs",
        "--manifest-url", "https://example.test/manifest.json",
        "--artifact-url", "https://example.test/component.bin,https://example.test/quickjs.bin",
        "--output", output,
      ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("TAURI_RELEASE_EVIDENCE_FAILED");
      expect(result.stdout).toContain('"componentId": "quickjs"');
      expect(existsSync(join(output, "tauri-components-release.json"))).toBe(false);
      expect(existsSync(join(output, "tauri-signature.json"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("requires an explicit clean Win11 runner opt-in", () => {
    const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/tauri-clean-win11-e2e.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, QX_TAURI_CLEAN_E2E: "" },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("TAURI_CLEAN_WIN11_E2E_REQUIRES_QX_TAURI_CLEAN_E2E=1");
  });
});
