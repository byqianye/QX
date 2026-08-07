import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SqliteDataLayer } from "../src/data/sqlite.js";
import {
  Aria2Backend,
  FakeDownloadBackend,
} from "../src/downloads/download-backend.js";
import {
  DownloadService,
  sanitizeDownloadFilename,
} from "../src/downloads/download-service.js";

const directories: string[] = [];
const layers: SqliteDataLayer[] = [];

describe("G64 download manager", () => {
  afterEach(() => {
    while (layers.length > 0) layers.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("registers an opaque target directory and sanitizes traversal/reserved filenames", async () => {
    const { service, targetPath } = createService(new FakeDownloadBackend({ autoComplete: true }));
    const target = await service.selectTargetDirectory(targetPath);
    await expect(service.add({
      title: "Fixture download",
      requestReference: "https://media.example.test/files/fixture.mp4",
      suggestedFilename: "..\\CON:.mp4",
      targetDirectoryId: target.id,
      explicitUserUrl: true,
    })).rejects.toMatchObject({ code: "DOWNLOAD_FILENAME_INVALID" });
    await expect(service.add({
      requestReference: "https://media.example.test/files/fixture.mp4",
      suggestedFilename: "CON.tar.gz",
      targetDirectoryId: target.id,
      explicitUserUrl: true,
    })).rejects.toMatchObject({ code: "DOWNLOAD_FILENAME_INVALID" });
    const task = await service.add({
      title: "Fixture download",
      requestReference: "https://media.example.test/files/fixture.mp4",
      suggestedFilename: "fixture.mp4",
      targetDirectoryId: target.id,
      explicitUserUrl: true,
    });

    expect(target.id).toMatch(/^download-dir-[a-f0-9]{24}$/);
    expect(task.status).toBe("completed");
    expect(task.suggestedFilename).not.toMatch(/[\\/:]/);
    expect(task.suggestedFilename.toUpperCase()).not.toMatch(/^CON(?:\.|$)/);
    expect(task.suggestedFilename).not.toContain("..");
    expect(sanitizeDownloadFilename("CON")).toBe("_CON");
    expect(JSON.stringify(service.uiState())).not.toContain(targetPath);
    expect(JSON.stringify(service.uiState())).not.toContain("https://media.example.test");
  });

  it("supports add, pause, resume, cancel, retry, remove, duplicate names, and completion", async () => {
    const backend = new FakeDownloadBackend();
    const { service, targetPath } = createService(backend);
    const target = await service.selectTargetDirectory(targetPath);
    const first = await service.add({
      requestReference: "https://media.example.test/files/fixture.mp4",
      suggestedFilename: "fixture.mp4",
      targetDirectoryId: target.id,
      explicitUserUrl: true,
    });
    const duplicate = await service.add({
      requestReference: "https://media.example.test/files/other.mp4",
      suggestedFilename: "fixture.mp4",
      targetDirectoryId: target.id,
      explicitUserUrl: true,
    });

    expect(first.status).toBe("downloading");
    expect(duplicate.suggestedFilename).toBe("fixture (1).mp4");
    expect((await service.pause(first.id)).status).toBe("paused");
    expect((await service.resume(first.id)).status).toBe("downloading");
    expect((await service.cancel(first.id)).status).toBe("cancelled");
    expect((await service.retry(first.id)).status).toBe("downloading");
    expect((await service.remove(first.id)).status).toBe("removed");
    expect((await service.refresh()).tasks).toHaveLength(1);
  });

  it("requires explicit download eligibility and rejects HLS and credential-bearing URLs", async () => {
    const { service, targetPath } = createService(new FakeDownloadBackend());
    const target = await service.selectTargetDirectory(targetPath);
    await expect(service.add({
      requestReference: "https://media.example.test/files/fixture.mp4",
      targetDirectoryId: target.id,
    })).rejects.toMatchObject({ code: "DOWNLOAD_NOT_ELIGIBLE" });
    await expect(service.add({
      requestReference: "https://media.example.test/live/index.m3u8",
      targetDirectoryId: target.id,
      explicitUserUrl: true,
    })).rejects.toMatchObject({ code: "DOWNLOAD_NOT_ELIGIBLE" });
    await expect(service.add({
      requestReference: "https://media.example.test/files/fixture.mp4?token=secret",
      targetDirectoryId: target.id,
      explicitUserUrl: true,
    })).rejects.toMatchObject({ code: "DOWNLOAD_URL_INVALID" });
    const legalSourceDownload = await service.add({
      requestReference: "https://media.example.test/files/playlist.m3u8",
      targetDirectoryId: target.id,
      sourceDownload: true,
    });
    expect(legalSourceDownload.status).toBe("downloading");
  });

  it("keeps task metadata after restart and pauses interrupted work", async () => {
    const { service, targetPath, databasePath } = createService(new FakeDownloadBackend());
    const target = await service.selectTargetDirectory(targetPath);
    const task = await service.add({
      title: "Restart fixture",
      requestReference: "https://media.example.test/files/restart.mp4",
      targetDirectoryId: target.id,
      explicitUserUrl: true,
    });
    expect(task.status).toBe("downloading");
    await service.close();
    const firstLayer = layers.pop();
    firstLayer?.close();
    const reopenedLayer = SqliteDataLayer.create(databasePath);
    layers.push(reopenedLayer);
    const reopened = new DownloadService({
      db: reopenedLayer,
      backend: new FakeDownloadBackend(),
      now: () => 2_000,
    });
    const state = reopened.uiState();
    expect(state.tasks[0]).toMatchObject({ id: task.id, status: "paused", title: "Restart fixture" });
    expect(state.targetDirectories[0]?.id).toBe(target.id);
    expect(JSON.stringify(state)).not.toContain(targetPath);
  });

  it("reports unavailable aria2 without exposing secrets and uses shell=false for JSON-RPC", async () => {
    const { service, targetPath } = createService(new Aria2Backend({
      executablePath: "aria2c.exe",
      exists: () => false,
    }));
    const target = await service.selectTargetDirectory(targetPath);
    expect(service.uiState().error).toMatchObject({ code: "ARIA2_UNAVAILABLE" });
    await expect(service.add({
      requestReference: "https://media.example.test/files/missing.mp4",
      targetDirectoryId: target.id,
      explicitUserUrl: true,
    })).rejects.toMatchObject({ code: "ARIA2_UNAVAILABLE" });
    expect(service.uiState().tasks[0]).toMatchObject({ status: "failed", error: "ARIA2_UNAVAILABLE" });

    const calls: { body?: Record<string, unknown>; args: readonly string[]; shell: boolean }[] = [];
    const processes: Array<{
      killed: boolean;
      emitExit: () => void;
    }> = [];
    const backend = new Aria2Backend({
      executablePath: "aria2c.exe",
      exists: () => true,
      rpcSecret: "test-secret",
      rpcPort: 18_765,
      spawnProcess: (_file, args, options) => {
        calls.push({ args, shell: options.shell });
        const listeners = new Set<() => void>();
        const process = {
          pid: 1234,
          killed: false,
          on(event: "exit" | "error", listener: (...args: any[]) => void) {
            if (event === "exit") listeners.add(listener as () => void);
            return this;
          },
          kill() {
            this.killed = true;
            for (const listener of listeners) listener();
            return true;
          },
          emitExit() {
            for (const listener of listeners) listener();
          },
        };
        processes.push(process);
        return process;
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ body, args: [], shell: false });
        const method = body.method;
        if (method === "aria2.addUri") return new Response(JSON.stringify({ result: "gid-1" }), { status: 200 });
        if (method === "aria2.tellStatus") {
          return new Response(JSON.stringify({ result: {
            status: "active",
            totalLength: "100",
            completedLength: "12",
            downloadSpeed: "8",
          } }), { status: 200 });
        }
        if (method === "aria2.shutdown") {
          processes.at(-1)?.emitExit();
        }
        return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
      },
    });
    const added = await backend.add({
      url: "https://media.example.test/files/fixture.mp4",
      targetDirectory: targetPath,
      filename: "fixture.mp4",
    });
    const status = await backend.status(added.backendId);
    processes[0]?.emitExit();
    await expect(backend.status(added.backendId)).rejects.toMatchObject({ code: "ARIA2_PROCESS_EXITED" });
    await backend.shutdown();
    const cleanBackend = new Aria2Backend({
      executablePath: "aria2c.exe",
      exists: () => true,
      rpcSecret: "test-secret",
      rpcPort: 18_765,
      spawnProcess: (_file, args, options) => {
        calls.push({ args, shell: options.shell });
        const listeners = new Set<() => void>();
        const process = {
          pid: 1235,
          killed: false,
          on(event: "exit" | "error", listener: (...args: any[]) => void) {
            if (event === "exit") listeners.add(listener as () => void);
            return this;
          },
          kill() {
            this.killed = true;
            for (const listener of listeners) listener();
            return true;
          },
          emitExit() {
            for (const listener of listeners) listener();
          },
        };
        processes.push(process);
        return process;
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.method === "aria2.shutdown") processes.at(-1)?.emitExit();
        return new Response(JSON.stringify({ result: body.method === "aria2.addUri" ? "gid-2" : "ok" }), { status: 200 });
      },
    });
    await cleanBackend.add({ url: "https://media.example.test/files/second.mp4", targetDirectory: targetPath, filename: "second.mp4" });
    await cleanBackend.shutdown();
    expect(processes[1]?.killed).toBe(false);
    expect(added).toMatchObject({ backendId: "gid-1", status: "starting" });
    expect(status).toMatchObject({ status: "downloading", totalBytes: 100, completedBytes: 12, speed: 8 });
    expect(calls.some((call) => call.shell === false)).toBe(true);
    expect(JSON.stringify(added)).not.toContain("test-secret");
    expect(JSON.stringify(status)).not.toContain("test-secret");
    expect(JSON.stringify(calls.find((call) => call.body?.method === "aria2.addUri")?.body)).toContain("token:test-secret");
  });

  it("maps a fake aria2 crash to a failed task", async () => {
    const backend = new FakeDownloadBackend();
    const { service, targetPath } = createService(backend);
    const target = await service.selectTargetDirectory(targetPath);
    await service.add({
      requestReference: "https://media.example.test/files/crash.mp4",
      targetDirectoryId: target.id,
      explicitUserUrl: true,
    });
    backend.crash();
    const state = await service.refresh();
    expect(state.tasks[0]).toMatchObject({ status: "failed", error: "FAKE_ARIA2_CRASHED" });
  });
});

function createService(backend: FakeDownloadBackend | Aria2Backend): {
  service: DownloadService;
  targetPath: string;
  databasePath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "qx-downloads-"));
  directories.push(directory);
  const targetPath = join(directory, "downloads");
  mkdirSync(targetPath);
  const databasePath = join(directory, "qx-yingshi.db");
  const layer = SqliteDataLayer.create(databasePath);
  layers.push(layer);
  return {
    service: new DownloadService({ db: layer, backend, now: () => 1_000 }),
    targetPath,
    databasePath,
  };
}
