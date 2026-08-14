import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Tauri component manifest generator", () => {
  it("writes a detached Ed25519 signature and derived public key for multiple components", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-tauri-component-manifest-"));
    try {
      const { privateKey } = generateKeyPairSync("ed25519");
      const privateKeyPath = join(directory, "release-key.pem");
      const firstArtifact = join(directory, "mpv.exe");
      const secondArtifact = join(directory, "quickjs.exe");
      const specPath = join(directory, "components.json");
      const outputDirectory = join(directory, "staging");
      writeFileSync(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
      writeFileSync(firstArtifact, Buffer.from("mpv component bytes"));
      writeFileSync(secondArtifact, Buffer.from("quickjs component bytes"));
      writeFileSync(specPath, JSON.stringify({
        components: [
          { id: "mpv", version: "2026.08.14", artifact: firstArtifact, url: "https://github.com/example/qx/releases/download/v1/mpv.exe" },
          { id: "quickjs", version: "2026.08.14", artifact: secondArtifact, url: "https://github.com/example/qx/releases/download/v1/quickjs.exe" },
        ],
      }));

      const result = runGenerator(privateKeyPath, specPath, outputDirectory);
      expect(result.status).toBe(0);

      const manifest = readFileSync(join(outputDirectory, "components-v1.json"));
      const signature = Buffer.from(readFileSync(join(outputDirectory, "components-v1.sig.b64"), "utf8").trim(), "base64");
      const rawPublicKey = Buffer.from(readFileSync(join(outputDirectory, "components-v1.pub.b64"), "utf8").trim(), "base64");
      const publicKey = createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPublicKey]),
        format: "der",
        type: "spki",
      });
      const decoded = JSON.parse(manifest.toString("utf8")) as { version: number; components: Array<{ id: string; sha256: string }> };
      expect(decoded.version).toBe(1);
      expect(decoded.components.map((component) => component.id)).toEqual(["mpv", "quickjs"]);
      expect(rawPublicKey).toHaveLength(32);
      expect(signature).toHaveLength(64);
      expect(verify(null, manifest, publicKey, signature)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a non-HTTPS component URL before writing release material", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-tauri-component-manifest-"));
    try {
      const { privateKey } = generateKeyPairSync("ed25519");
      const privateKeyPath = join(directory, "release-key.pem");
      const artifactPath = join(directory, "mpv.exe");
      const specPath = join(directory, "components.json");
      const outputDirectory = join(directory, "staging");
      writeFileSync(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
      writeFileSync(artifactPath, Buffer.from("component bytes"));
      writeFileSync(specPath, JSON.stringify([{ id: "mpv", version: "1", artifact: artifactPath, url: "http://example.invalid/mpv.exe" }]));

      const result = runGenerator(privateKeyPath, specPath, outputDirectory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("must be an HTTPS URL");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function runGenerator(privateKeyPath: string, specPath: string, outputDirectory: string) {
  const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(process.cwd(), "scripts", "tauri-component-manifest.ts");
  return spawnSync(process.execPath, [tsx, script, "--private-key", privateKeyPath, "--components", specPath, "--output-dir", outputDirectory], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}
