import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { AndroidDeviceManagerError, type AndroidDeviceManagerPort } from "../src/spider/android-device-manager.js";
import { AndroidSpiderBridgeClient, type AndroidSpiderHostMethod } from "../src/spider/android-spider-bridge-client.js";

class FakeDeviceManager implements AndroidDeviceManagerPort {
  public readonly pushed: string[] = [];
  public started = 0;
  public stopped = 0;
  public removedForwards = 0;

  public constructor(private readonly available = true) {}

  public async requireDevice() {
    if (!this.available) throw new AndroidDeviceManagerError("ANDROID_DEVICE_NOT_FOUND", "No device");
    return { serial: "emulator-5554", state: "device" } as const;
  }

  public async forward() {}
  public async removeForward() { this.removedForwards += 1; }
  public async install() {}
  public async startHost() { this.started += 1; }
  public async stopHost() { this.stopped += 1; }
  public async push(localPath: string, remotePath: string) { this.pushed.push(`${localPath}=>${remotePath}`); }
  public async shell() { return ""; }
}

describe("AndroidSpiderBridgeClient", () => {
  it("serializes protocol v1 requests and returns a real health result", async () => {
    const server = await createServer((request, socket) => {
      expect(request.protocolVersion).toBe(1);
      expect(request.method).toBe("health");
      respond(socket, request.id, { status: "ok", version: "0.1.0" });
    });
    const manager = new FakeDeviceManager();
    const client = new AndroidSpiderBridgeClient({ deviceManager: manager, localPort: server.port, remotePort: server.port });
    try {
      await expect(client.health()).resolves.toMatchObject({ status: "ok", version: "0.1.0" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("surfaces an unavailable Android device without calling it a host failure", async () => {
    const client = new AndroidSpiderBridgeClient({ deviceManager: new FakeDeviceManager(false) });
    await expect(client.connect()).rejects.toMatchObject({ code: "ANDROID_DEVICE_NOT_FOUND" });
  });

  it("reports a missing Host socket as HOST_OFFLINE", async () => {
    const manager = new FakeDeviceManager();
    const client = new AndroidSpiderBridgeClient({ deviceManager: manager, localPort: unusedPort(), remotePort: unusedPort() });
    await expect(client.connect()).rejects.toMatchObject({ code: "HOST_OFFLINE" });
  });

  it("times out and allows only one bounded recovery attempt", async () => {
    const server = await createServer((request, socket) => {
      if (request.method === "health") respond(socket, request.id, { status: "ok" });
    });
    const manager = new FakeDeviceManager();
    const client = new AndroidSpiderBridgeClient({
      deviceManager: manager,
      localPort: server.port,
      remotePort: server.port,
      healthTimeoutMs: 100,
      requestTimeoutMs: 30,
      operationTimeoutMs: 30,
    });
    try {
      await client.connect();
      await expect(client.request("runtimeInfo", {})).rejects.toMatchObject({ code: "ANDROID_BRIDGE_TIMEOUT" });
      expect(manager.started).toBe(1);
      expect(manager.stopped).toBe(1);
      await expect(client.request("runtimeInfo", {})).rejects.toMatchObject({ code: "ANDROID_BRIDGE_TIMEOUT" });
      expect(manager.started).toBe(1);
      expect(manager.stopped).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("aborts a pending request without restarting the Host", async () => {
    const server = await createServer((request, socket) => {
      if (request.method === "health") respond(socket, request.id, { status: "ok" });
    });
    const manager = new FakeDeviceManager();
    const client = new AndroidSpiderBridgeClient({
      deviceManager: manager,
      localPort: server.port,
      remotePort: server.port,
      healthTimeoutMs: 100,
      requestTimeoutMs: 1_000,
    });
    const controller = new AbortController();
    try {
      await client.connect();
      const pending = client.request("runtimeInfo", {}, 1_000, true, controller.signal);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "ANDROID_BRIDGE_ABORTED" });
      expect(manager.started).toBe(0);
      expect(manager.stopped).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("verifies the Windows and Android artifact hashes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-android-client-hash-"));
    const artifact = join(directory, "spider.jar");
    const bytes = Buffer.from("real-artifact");
    const expected = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(artifact, bytes);
    const server = await createServer((request, socket) => {
      if (request.method === "health") respond(socket, request.id, { status: "ok" });
      if (request.method === "loadJar") respond(socket, request.id, { jarId: "bad", sha256: "0".repeat(64) });
    });
    const client = new AndroidSpiderBridgeClient({ deviceManager: new FakeDeviceManager(), localPort: server.port, remotePort: server.port });
    try {
      await client.connect();
      await expect(client.loadJar(artifact)).rejects.toMatchObject({
        code: "JAR_TRANSFER_HASH_MISMATCH",
        diagnostics: { expectedSha256: expected, actualSha256: "0".repeat(64) },
      });
    } finally {
      await client.close();
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

interface TestServer {
  port: number;
  close(): Promise<void>;
}

async function createServer(handler: (request: { id: string; method: AndroidSpiderHostMethod; protocolVersion: number; params: Record<string, unknown> }, socket: net.Socket) => void): Promise<TestServer> {
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) handler(JSON.parse(line) as Parameters<typeof handler>[0], socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function respond(socket: net.Socket, id: string, result: unknown): void {
  socket.write(`${JSON.stringify({ id, protocolVersion: 1, success: true, result })}\n`);
}

function unusedPort(): number {
  return 49_999;
}
