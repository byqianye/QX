import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  ConfigHistoryStore,
  JsonFileConfigHistoryPersistence,
} from "../src/config/history.js";

const firstConfig = JSON.stringify({
  sites: [{ key: "a", name: "A", api: "csp_Douban" }],
});
const secondConfig = JSON.stringify({
  sites: [
    { key: "a", name: "A changed", api: "csp_Douban" },
    { key: "b", name: "B", api: "js:./b.mjs" },
  ],
  spider: "./global.mjs",
});

describe("configuration history and offline cache", () => {
  it("keeps successful versions, summarizes changes, and rolls back", () => {
    const store = new ConfigHistoryStore(undefined, 5);
    const first = store.recordSuccessful("https://example.invalid/config.json", "url", firstConfig, {
      etag: "v1",
    });
    const second = store.recordSuccessful("https://example.invalid/config.json", "url", secondConfig, {
      etag: "v2",
      lastModified: "today",
    });

    expect(store.versions(first.source)).toHaveLength(2);
    expect(second.change.addedSites).toEqual(["b"]);
    expect(second.change.changedSites).toEqual(["a"]);
    expect(second.change.spiderChanged).toBe(true);
    expect(second.validators).toEqual({ etag: "v2", lastModified: "today" });

    expect(store.rollback(first.source, first.id).config).toEqual(JSON.parse(firstConfig));
    expect(store.cached(first.source)?.id).toBe(first.id);

    expect(() => store.recordSuccessful(first.source, "url", "{not-json"))
      .toThrow("Configuration is not valid JSON");
    expect(store.versions(first.source)).toHaveLength(2);
    expect(store.cached(first.source)?.id).toBe(first.id);
  });

  it("uses validators and falls back to the last good config when refresh fails", async () => {
    const store = new ConfigHistoryStore();
    const first = await store.refresh("https://example.invalid/config.json", "url", async (validators) => {
      expect(validators).toBeNull();
      return { body: firstConfig, etag: "etag-1", lastModified: "lm-1" };
    });
    expect(first.usedCache).toBe(false);
    expect(first.changed).toBe(true);

    const offline = await store.refresh("https://example.invalid/config.json", "url", async (validators) => {
      expect(validators).toEqual({ etag: "etag-1", lastModified: "lm-1" });
      throw new Error("network unavailable");
    });
    expect(offline.usedCache).toBe(true);
    expect(offline.config).toEqual(JSON.parse(firstConfig));
    expect(offline.error).toBe("network unavailable");

    const notModified = await store.refresh("https://example.invalid/config.json", "url", async () => ({
      notModified: true,
    }));
    expect(notModified.usedCache).toBe(true);
    expect(notModified.changed).toBe(false);
    expect(store.versions("https://example.invalid/config.json")).toHaveLength(1);
  });

  it("persists history and supports deleting one version or an entire source", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-config-history-"));
    const path = join(directory, "history.json");
    const source = "file:///config.json";
    try {
      const first = new ConfigHistoryStore(new JsonFileConfigHistoryPersistence(path));
      const version = first.recordSuccessful(source, "file", firstConfig);
      const second = first.recordSuccessful(source, "file", secondConfig);
      const restored = new ConfigHistoryStore(new JsonFileConfigHistoryPersistence(path));
      expect(restored.cached(source)?.id).toBe(second.id);
      restored.delete(source, second.id);
      expect(restored.cached(source)?.id).toBe(version.id);
      expect(readFileSync(path, "utf8")).toContain(version.id);
      restored.delete(source);
      expect(restored.sources()).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("detects Spider content changes when the configuration body is unchanged", async () => {
    const store = new ConfigHistoryStore();
    const source = "https://example.invalid/config.json";
    const spider = "https://spider.example.invalid/demo.mjs";
    const body = JSON.stringify({ sites: [{ key: "js", api: `js:${spider}` }] });

    const first = await store.refresh(source, "url", async () => ({
      body,
      spiderHashes: { [spider]: "hash-v1" },
    }));
    expect(first.changed).toBe(true);

    const second = await store.refresh(
      source,
      "url",
      async () => ({ notModified: true }),
      async () => ({ [spider]: "hash-v2" }),
    );

    expect(second.changed).toBe(true);
    expect(second.version?.change.spiderChanged).toBe(false);
    expect(second.version?.change.spiderContentChanged).toBe(true);
    expect(second.version?.spiderHashes).toEqual({ [spider]: "hash-v2" });
  });
});
