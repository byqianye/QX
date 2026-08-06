import { mkdtempSync, rmSync } from "node:fs";
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
});
