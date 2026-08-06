import { describe, expect, it } from "vitest";

import { SiteManager } from "../src/desktop/site-management.js";

describe("site management", () => {
  it("exposes engine, capabilities, trust, and user preferences as data", () => {
    const manager = new SiteManager({
      config: {
        spider: "fixture.jar",
        sites: [
          { key: "java", name: "Java", api: "csp_Douban" },
          { key: "js", name: "JavaScript", api: "js:./demo.mjs" },
          { key: "python", name: "Python", api: "py:./demo.py" },
          { key: "unknown", name: "Unknown", api: "csp_Unknown" },
        ],
      },
      trusted: true,
      preferences: {
        js: { alias: "JS source", enabled: false, searchEnabled: false, order: 0 },
      },
    });

    expect(manager.list().map((site) => site.key)).toEqual(["js", "java", "python", "unknown"]);
    expect(manager.get("js")).toMatchObject({
      alias: "JS source",
      engine: "quickjs",
      enabled: false,
      searchEnabled: false,
      trusted: true,
    });
    expect(manager.reorder(["unknown", "java", "js", "python"]).map((site) => site.key))
      .toEqual(["unknown", "java", "js", "python"]);
    expect(manager.get("java")?.capabilities.playback).toBe(false);
    expect(manager.get("unknown")).toMatchObject({
      engine: "unsupported",
      capabilities: { search: false, playback: false },
    });
  });

  it("filters disabled and non-searchable sources and tracks maintenance actions", () => {
    const manager = new SiteManager({
      config: { sites: [{ key: "playable", api: "csp_PlayableFixture" }] },
      trusted: false,
    });

    expect(manager.searchable().map((site) => site.key)).toEqual(["playable"]);
    manager.setSearchEnabled("playable", false);
    expect(manager.searchable()).toEqual([]);
    manager.setEnabled("playable", false);
    expect(manager.playbackAvailable("playable")).toBe(false);
    manager.setAlias("playable", "  Movie source  ");
    manager.recordSuccess("playable", 123);
    manager.recordError("playable", "timeout");
    manager.clearCache("playable");
    manager.reinitialize("playable");
    expect(manager.get("playable")).toMatchObject({
      alias: "Movie source",
      trusted: false,
      lastSuccessAt: 123,
      lastError: null,
      cacheGeneration: 1,
      reinitializeGeneration: 1,
    });
  });
});
