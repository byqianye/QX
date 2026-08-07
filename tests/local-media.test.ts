import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { LocalMediaError, LocalMediaService } from "../src/local-media/local-media-service.js";
import { openSqliteDataLayer, type SqliteDataLayer } from "../src/data/sqlite.js";

const directories: string[] = [];
const layers: SqliteDataLayer[] = [];

describe("G63 local media", () => {
  afterEach(() => {
    while (layers.length > 0) layers.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("imports a file, scans an authorized folder, matches same-directory subtitles, and persists opaque ids", async () => {
    const { service, directory } = createService();
    const media = join(directory, "movie.mp4");
    const subtitle = join(directory, "movie.zh-CN.srt");
    const nested = join(directory, "season-1");
    mkdirSync(nested);
    writeFileSync(media, Buffer.alloc(16));
    writeFileSync(subtitle, "1\n00:00:00,000 --> 00:00:01,000\nHello\n");
    writeFileSync(join(nested, "episode.webm"), Buffer.alloc(8));

    const opened = await service.openFiles([media]);
    const folderState = await service.addFolder(directory);
    expect(folderState.items).toHaveLength(2);
    expect(opened[0]).toMatchObject({
      displayName: "movie.mp4",
      pathIdentity: expect.stringMatching(/^local-file:/),
      fileReference: expect.stringMatching(/^local-file:/),
    });
    expect(JSON.stringify(folderState)).not.toContain(directory);
    const movie = folderState.items.find((item) => item.displayName === "movie.mp4");
    expect(movie?.subtitleTracks).toEqual([
      expect.objectContaining({ label: "movie.zh-CN.srt", language: "zh-cn", format: "srt" }),
    ]);
    expect(movie?.fileReference).not.toContain(directory);
  });

  it("serves local HLS only through safe relative resources and rejects escapes", async () => {
    const { service, directory } = createService();
    writeFileSync(join(directory, "segment.ts"), Buffer.alloc(12));
    const playlist = join(directory, "safe.m3u8");
    writeFileSync(playlist, "#EXTM3U\n#EXTINF:1,\nsegment.ts\n");
    const state = await service.addFolder(directory);
    const item = state.items.find((candidate) => candidate.displayName === "safe.m3u8");
    if (!item) throw new Error("Expected HLS fixture");
    const rewritten = service.validatePlaylist(item.id);
    expect(rewritten).toContain("/api/local-media/resource/");
    expect(rewritten).not.toContain("segment.ts\n");
    const token = rewritten.match(/\/api\/local-media\/resource\/[^/]+\/([^\s]+)/)?.[1];
    if (!token) throw new Error("Expected playlist resource token");
    expect(service.resolvePlaylistResource(item.id, token).size).toBe(12);

    writeFileSync(join(directory, "escape.m3u8"), "#EXTM3U\n../outside.ts\n");
    const next = await service.rescan(state.folders[0]?.id);
    const escape = next.items.find((candidate) => candidate.displayName === "escape.m3u8");
    if (!escape) throw new Error("Expected escape fixture");
    expect(() => service.validatePlaylist(escape.id)).toThrowError(
      expect.objectContaining({ code: "LOCAL_MEDIA_PLAYLIST_PATH_UNAUTHORIZED" }),
    );
  });

  it("uses MPV only when available and keeps HTML media independent", async () => {
    const { service, directory } = createService();
    const mp4 = join(directory, "browser.mp4");
    const mkv = join(directory, "needs-mpv.mkv");
    writeFileSync(mp4, Buffer.alloc(4));
    writeFileSync(mkv, Buffer.alloc(4));
    const items = await service.openFiles([mp4, mkv]);
    expect(service.preparePlayback(items[0]!.id, "http://127.0.0.1:1234/").backend).toBe("html-video");
    expect(() => service.preparePlayback(items[1]!.id, "http://127.0.0.1:1234/")).toThrowError(
      expect.objectContaining({ code: "MPV_UNAVAILABLE" }),
    );
  });

  it("rejects unsupported extensions and does not walk deep or linked directories", async () => {
    const { service, directory } = createService({ maxDepth: 1 });
    const outside = mkdtempSync(join(tmpdir(), "qx-local-media-outside-"));
    directories.push(outside);
    writeFileSync(join(directory, "root.mp4"), Buffer.alloc(4));
    writeFileSync(join(directory, "notes.txt"), "not media");
    const deep = join(directory, "one", "two");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "deep.mp4"), Buffer.alloc(4));
    writeFileSync(join(outside, "outside.mp4"), Buffer.alloc(4));
    try {
      symlinkSync(outside, join(directory, "linked-outside"), "junction");
    } catch {
      // Junction creation can be disabled by the Windows test account; the scanner still verifies the depth boundary.
    }

    const state = await service.addFolder(directory);
    expect(state.items.map((item) => item.displayName)).toContain("root.mp4");
    expect(state.items.map((item) => item.displayName)).not.toContain("deep.mp4");
    expect(state.items.map((item) => item.displayName)).not.toContain("outside.mp4");
    await expect(service.openFiles([join(directory, "notes.txt")])).rejects.toMatchObject({
      code: "LOCAL_MEDIA_EXTENSION_UNSUPPORTED",
    });
  });

  it("enforces file limits, supports cancellation state, incremental rescans, missing files, and locate", async () => {
    const { service, directory } = createService({ maxFiles: 1 });
    writeFileSync(join(directory, "one.mp4"), Buffer.alloc(4));
    writeFileSync(join(directory, "two.mp4"), Buffer.alloc(4));
    await expect(service.addFolder(directory)).rejects.toMatchObject({ code: "LOCAL_MEDIA_FILE_LIMIT" });

    const { service: incremental, directory: secondDirectory } = createService();
    const firstPath = join(secondDirectory, "same.mp4");
    writeFileSync(firstPath, Buffer.alloc(4));
    const first = await incremental.addFolder(secondDirectory);
    const firstItem = first.items[0];
    if (!firstItem || !first.folders[0]) throw new Error("Expected scanned item");
    const second = await incremental.rescan(first.folders[0].id);
    expect(second.items.find((item) => item.id === firstItem.id)?.updatedAt).toBe(firstItem.updatedAt);
    rmSync(firstPath);
    expect(() => incremental.preparePlayback(firstItem.id, "http://127.0.0.1:1234/")).toThrowError(
      expect.objectContaining({ code: "LOCAL_MEDIA_NOT_FOUND" }),
    );
    const replacement = join(secondDirectory, "same.mp4");
    writeFileSync(replacement, Buffer.alloc(6));
    const located = await incremental.locateItem(firstItem.id, replacement);
    expect(located.items.find((item) => item.id === firstItem.id)?.missing).toBe(false);
    const outsideDirectory = mkdtempSync(join(tmpdir(), "qx-local-media-located-"));
    directories.push(outsideDirectory);
    const moved = join(outsideDirectory, "same.mp4");
    writeFileSync(moved, Buffer.alloc(6));
    const movedState = await incremental.locateItem(firstItem.id, moved);
    expect(movedState.items.find((item) => item.id === firstItem.id)?.rootId).toBeNull();
  });

  it("cancels a long-running folder rescan without leaving a live scanner", async () => {
    const { service, directory } = createService();
    for (let index = 0; index < 120; index += 1) {
      writeFileSync(join(directory, `episode-${String(index).padStart(3, "0")}.mp4`), Buffer.alloc(4));
    }
    const first = await service.addFolder(directory);
    const rootId = first.folders[0]?.id;
    if (!rootId) throw new Error("Expected local media folder");

    const pending = service.rescan(rootId);
    service.cancelScan(rootId);
    await expect(pending).rejects.toMatchObject({ code: "LOCAL_MEDIA_SCAN_CANCELLED" });
    expect(service.uiState().scan).toMatchObject({ rootId: null, status: "cancelled" });
  });

  it("survives a data-layer restart without exposing file paths", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-local-media-restart-"));
    directories.push(directory);
    const mediaDirectory = join(directory, "library");
    mkdirSync(mediaDirectory);
    const mediaPath = join(mediaDirectory, "restart.mp4");
    writeFileSync(mediaPath, Buffer.alloc(7));
    const dbPath = join(directory, "library.db");
    const firstLayer = openSqliteDataLayer(dbPath).layer;
    layers.push(firstLayer);
    const firstService = new LocalMediaService({ db: firstLayer });
    const first = await firstService.addFolder(mediaDirectory);
    firstLayer.close();
    layers.splice(layers.indexOf(firstLayer), 1);
    const secondLayer = openSqliteDataLayer(dbPath).layer;
    layers.push(secondLayer);
    const secondService = new LocalMediaService({ db: secondLayer });
    const second = secondService.uiState();
    expect(second.items[0]?.id).toBe(first.items[0]?.id);
    expect(JSON.stringify(second)).not.toContain(mediaDirectory);
  });
});

function createService(options: { maxFiles?: number; maxDepth?: number } = {}): { service: LocalMediaService; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "qx-local-media-"));
  directories.push(directory);
  const dbDirectory = join(directory, "data");
  mkdirSync(dbDirectory);
  const layer = openSqliteDataLayer(join(dbDirectory, "data.db")).layer;
  layers.push(layer);
  return { service: new LocalMediaService({ db: layer, ...options }), directory };
}
