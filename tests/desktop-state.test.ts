import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DESKTOP_STATE,
  JsonFileDesktopStateStore,
  restoreWindowBounds,
  type DesktopStateFileSystem,
} from "../src/desktop/state-persistence.js";

describe("desktop state persistence", () => {
  const directories: string[] = [];

  afterEach(() => {
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes safe page and theme state atomically and restores it", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-desktop-state-"));
    directories.push(directory);
    const path = join(directory, "desktop-state.json");
    const store = new JsonFileDesktopStateStore(path);

    const result = store.patch({
      theme: "dark",
      page: {
        navigation: "search",
        siteKey: "douban",
        category: { typeId: "hot_gaia", page: 2 },
        search: { key: "蜘蛛侠", page: 3 },
        scrollTop: 420,
        recentDetailId: "msearch:36246195",
      },
    });

    expect(result.ok).toBe(true);
    expect(new JsonFileDesktopStateStore(path).state).toMatchObject({
      theme: "dark",
      page: {
        navigation: "search",
        siteKey: "douban",
        category: { typeId: "hot_gaia", page: 2 },
        search: { key: "蜘蛛侠", page: 3 },
        scrollTop: 420,
        recentDetailId: "msearch:36246195",
      },
    });
    expect(readdirSync(directory).filter((name) => name.includes(".tmp"))).toHaveLength(0);
    expect(readFileSync(path, "utf8")).not.toContain("Authorization");
  });

  it("falls back safely and backs up corrupted JSON without blocking startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-desktop-state-corrupt-"));
    directories.push(directory);
    const path = join(directory, "desktop-state.json");
    writeFileSync(path, "{not-json", "utf8");

    const store = new JsonFileDesktopStateStore(path);

    expect(store.state).toEqual(DEFAULT_DESKTOP_STATE);
    expect(store.lastDiagnostic).toMatchObject({ code: "STATE_PERSISTENCE_CORRUPT" });
    expect(store.rendererState().diagnostic).toMatchObject({ code: "STATE_PERSISTENCE_CORRUPT" });
    expect(readdirSync(directory).some((name) => name.startsWith("desktop-state.json.corrupt-") && name.endsWith(".bak"))).toBe(true);
  });

  it("does not persist URL credentials or sensitive identifiers", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-desktop-state-safe-"));
    directories.push(directory);
    const path = join(directory, "desktop-state.json");
    const store = new JsonFileDesktopStateStore(path);

    expect(store.patch({
      page: {
        siteKey: "https://media.example.invalid/config.json?token=secret",
        recentDetailId: "https://media.example.invalid/video.m3u8?Authorization=secret",
        search: { key: "普通搜索", page: 1 },
      },
    }).ok).toBe(true);

    const saved = readFileSync(path, "utf8");
    expect(saved).not.toContain("media.example.invalid");
    expect(saved).not.toContain("secret");
    expect(new JsonFileDesktopStateStore(path).state.page).toMatchObject({
      siteKey: null,
      recentDetailId: null,
      search: { key: "普通搜索", page: 1 },
    });

    expect(store.patch({ page: { search: { key: "Authorization=secret", page: 1 } } }).state.page.search).toBeNull();
    expect(readFileSync(path, "utf8")).not.toContain("Authorization");
  });

  it("reports a write failure once without blocking the current session", () => {
    const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
    const io: DesktopStateFileSystem = {
      mkdirSync: () => undefined,
      readFileSync: () => { throw missing; },
      writeFileSync: () => { throw new Error("disk full"); },
      renameSync: () => undefined,
      unlinkSync: () => undefined,
    };
    const store = new JsonFileDesktopStateStore("C:\\state\\desktop-state.json", io);

    const result = store.patch({ theme: "dark" });

    expect(result.ok).toBe(false);
    expect(result.state.theme).toBe("dark");
    expect(result.diagnostic).toMatchObject({ code: "STATE_PERSISTENCE_WRITE_FAILED" });
  });

  it("restores bounds inside a current display work area", () => {
    const displays = [
      { x: 1920, y: 0, width: 1920, height: 1040 },
      { x: 0, y: 0, width: 1920, height: 1040 },
    ];
    const primary = displays[1]!;

    expect(restoreWindowBounds({ width: 1280, height: 860, x: 6000, y: 500, isMaximized: false }, displays, primary)).toEqual({
      x: 320,
      y: 90,
      width: 1280,
      height: 860,
    });
    expect(restoreWindowBounds({ width: 5000, height: 5000, x: 2500, y: 20, isMaximized: true }, displays, primary)).toEqual({
      x: 1920,
      y: 0,
      width: 1920,
      height: 1040,
    });
  });

  it("preserves the maximize flag separately from normal window bounds", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-desktop-state-max-"));
    directories.push(directory);
    const store = new JsonFileDesktopStateStore(join(directory, "desktop-state.json"));

    expect(store.patch({ window: { width: 1180, height: 760, x: 32, y: 48, isMaximized: true } }).state.window).toEqual({
      width: 1180,
      height: 760,
      x: 32,
      y: 48,
      isMaximized: true,
    });
  });
});
