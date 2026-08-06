import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ImportTrustStore,
  inspectImport,
  JsonFileTrustPersistence,
} from "../src/config/trust.js";

describe("configuration trust boundary", () => {
  it("requires confirmation on the first remote import", () => {
    const store = new ImportTrustStore();
    const assessment = inspectImport(
      "http://example.invalid/config.json",
      { sites: [{ key: "demo", api: "csp_Demo" }] },
      store,
    );

    expect(assessment.requiresConfirmation).toBe(true);
    expect(assessment.executesCode).toBe(true);
  });

  it("remembers an explicit trust decision for the same source", () => {
    const source = "http://example.invalid/config.json";
    const store = new ImportTrustStore();
    store.trust(source);

    expect(inspectImport(source, { sites: [] }, store).requiresConfirmation).toBe(false);
  });

  it("does not let source-only legacy trust bypass a content-bound execution check", () => {
    const source = "http://example.invalid/config.json";
    const store = new ImportTrustStore();
    store.trust(source);

    const assessment = inspectImport(source, {
      sites: [{ key: "demo", api: "csp_Demo" }],
    }, store);
    expect(assessment.requiresConfirmation).toBe(true);
    expect(assessment.fileChanged).toBe(true);
  });

  it("persists explicit trust decisions across store instances", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-trust-"));
    const path = join(directory, "trusted-sources.json");
    const source = "http://example.invalid/config.json";

    try {
      const first = new ImportTrustStore(new JsonFileTrustPersistence(path));
      first.trust(source);

      const second = new ImportTrustStore(new JsonFileTrustPersistence(path));
      expect(second.isTrusted(source)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires re-confirmation when a local Spider file changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-trust-hash-"));
    const spiderPath = join(directory, "spider.mjs");
    const source = "file:///config.json";
    const config = { sites: [{ key: "js", api: `js:${spiderPath}` }] };

    try {
      writeFileSync(spiderPath, "export default { home: () => ({ list: [] }) };\n", "utf8");
      const store = new ImportTrustStore();
      const first = inspectImport(source, config, store);
      expect(first.spiderHashes).toHaveProperty(spiderPath);
      store.trustAssessment(first);
      expect(inspectImport(source, config, store).requiresConfirmation).toBe(false);

      writeFileSync(spiderPath, "export default { home: () => ({ list: [{ vod_name: 'changed' }] }) };\n", "utf8");
      const changed = inspectImport(source, config, store);
      expect(changed.fileChanged).toBe(true);
      expect(changed.requiresConfirmation).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("binds remote Spider trust to fetched content while hiding credentials", async () => {
    const source = "https://config.example/config.json?token=super-secret";
    const spider = "https://spider.example/demo.mjs?cookie=private-cookie";
    const config = {
      sites: [{ key: "js", api: `js:${spider}`, cookie: "session-secret" }],
    };
    let content = "export default { home: () => ({ list: [] }) };";
    const fetchText = async (url: string): Promise<string> => {
      expect(url).toBe(spider);
      return content;
    };
    const directory = mkdtempSync(join(tmpdir(), "qx-trust-remote-"));
    const path = join(directory, "trusted.json");

    try {
      const store = new ImportTrustStore(new JsonFileTrustPersistence(path));
      const first = await import("../src/config/trust.js").then(({ inspectImportAsync }) =>
        inspectImportAsync(source, config, store, { fetchText }));
      expect(first.requiresConfirmation).toBe(true);
      store.trustAssessment(first);

      const trusted = await import("../src/config/trust.js").then(({ inspectImportAsync }) =>
        inspectImportAsync(source, config, store, { fetchText }));
      expect(trusted.requiresConfirmation).toBe(false);

      content = "export default { home: () => ({ list: [{ vod_name: 'changed' }] }) };";
      const changed = await import("../src/config/trust.js").then(({ inspectImportAsync }) =>
        inspectImportAsync(source, config, store, { fetchText }));
      expect(changed.fileChanged).toBe(true);
      expect(changed.requiresConfirmation).toBe(true);

      const persisted = readFileSync(path, "utf8");
      expect(persisted).not.toContain("super-secret");
      expect(persisted).not.toContain("private-cookie");
      expect(persisted).not.toContain("session-secret");
      expect(persisted).toContain("config.example/config.json");
      expect(persisted).not.toContain("?token=");

      store.revoke(source);
      expect(store.isTrusted(source)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not treat a synchronous remote Spider fallback as a content hash", () => {
    const source = "https://config.example/config.json";
    const spider = "https://spider.example/demo.mjs";
    const config = { sites: [{ key: "js", api: `js:${spider}` }] };
    const store = new ImportTrustStore();
    const assessment = inspectImport(source, config, store);

    expect(assessment.spiderHashes[spider]).toMatch(/^unavailable:/);
    store.trustAssessment(assessment);
    expect(inspectImport(source, config, store).requiresConfirmation).toBe(true);
  });
});
