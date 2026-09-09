import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createBackendRequest,
  isBackendResponse,
  type ComponentManagerSnapshot,
} from "../renderer/src/contracts.js";

describe("Tauri component manager contract", () => {
  it("represents verification and activation without exposing a process handle", () => {
    const payload = {
      action: "verify" as const,
      componentId: "quickjs",
      manifestJson: '{"version":1,"components":[]}',
      signatureBase64: "signature",
      publicKeyBase64: "public-key",
    };
    const snapshot: ComponentManagerSnapshot = {
      state: "verified",
      componentId: "quickjs",
      version: "1",
      verified: true,
    };
    const response = {
      ...createBackendRequest(payload, "request-1", "session-1", 1),
      ok: true as const,
      payload: snapshot,
    };
    expect(isBackendResponse<ComponentManagerSnapshot>(response)).toBe(true);
    expect(JSON.stringify(response)).not.toMatch(/ipc|processHandle|secret/i);
  });

  it("keeps mpv lifecycle on a separate versioned RPC contract", () => {
    const payload = {
      action: "command" as const,
      sessionId: "mpv-session",
      command: ["set_property", "pause", false],
    };
    const response = {
      ...createBackendRequest(payload, "request-2", "session-2", 2),
      ok: true as const,
      payload: { sessionId: payload.sessionId, state: "ready" as const },
    };
    expect(isBackendResponse(response)).toBe(true);
    expect(JSON.stringify(response)).not.toContain("executable");
  });

  it("keeps optional QuickJS and mpv payloads out of the core NSIS resources", () => {
    const config = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../src-tauri/tauri.conf.json"), "utf8"),
    ) as { bundle?: { resources?: Record<string, string> } };
    expect(config.bundle?.resources).toEqual({});
    expect(Object.values(config.bundle?.resources ?? {}).join("\n")).not.toMatch(/quickjs|mpv/i);

    const coreCargo = readFileSync(resolve(import.meta.dirname, "../src-tauri/Cargo.toml"), "utf8");
    const sidecarCargo = readFileSync(
      resolve(import.meta.dirname, "../src-tauri/quickjs-sidecar/Cargo.toml"),
      "utf8",
    );
    expect(coreCargo).not.toContain('name = "qx-quickjs-sidecar"');
    expect(sidecarCargo).toContain('name = "qx-quickjs-sidecar"');
  });

  it("requires a compile-time release trust anchor for component signatures", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src-tauri/src/component_manager.rs"),
      "utf8",
    );
    expect(source).toContain('"install-default" => install_default(root, payload)');
    expect(source).toContain('option_env!("QX_COMPONENT_MANIFEST_URL")');
    expect(source).toContain('option_env!("QX_COMPONENT_SIGNATURE_URL")');
    expect(source).toContain('option_env!("QX_COMPONENT_PUBLIC_KEY_BASE64")');
    expect(source).toContain("component public key does not match the release trust anchor");
    expect(source).toContain("release component trust anchor is not configured");
    const buildScript = readFileSync(resolve(import.meta.dirname, "../src-tauri/build.rs"), "utf8");
    expect(buildScript).toContain("release builds require QX_COMPONENT_PUBLIC_KEY_BASE64");
    expect(buildScript).toContain("cargo:rustc-env=QX_COMPONENT_PUBLIC_KEY_BASE64");
    expect(buildScript).toContain("QX_COMPONENT_MANIFEST_URL");
    expect(buildScript).toContain("QX_COMPONENT_SIGNATURE_URL");
    expect(buildScript).toContain("bytes[..43]");
  });

  it("publishes the default manifest and both runtime components from the signed workflow", () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, "../.github/workflows/tauri-signed-release.yml"),
      "utf8",
    );
    expect(workflow).toContain("QX_COMPONENT_MANIFEST_URL");
    expect(workflow).toContain("QX_COMPONENT_SIGNATURE_URL");
    expect(workflow).toContain('id = "quickjs"');
    expect(workflow).toContain('id = "mpv"');
    expect(workflow).toContain('qx-mpv.exe');
    expect(workflow).toContain('"quickjs,mpv"');
    expect(workflow).toContain('MPV: ${{ steps.components.outputs.mpv }}');
    expect(workflow).toContain("Component private key does not match QX_COMPONENT_PUBLIC_KEY_BASE64");
    expect(workflow).toContain("Finalize G112 report after verified release evidence");
    expect(workflow).toContain("npm run tauri:finalize-g112-release");
  });
});
