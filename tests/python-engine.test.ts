import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { PythonDesktopClient } from "../src/spider/python-client.js";
import { PythonSidecar } from "../src/spider/python-sidecar.js";

const pythonExecutable = process.env.QX_PYTHON ?? "python";
const pythonAvailable = spawnSync(pythonExecutable, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;
const pythonDescribe = pythonAvailable ? describe : describe.skip;
const fixture = fileURLToPath(new URL("../fixtures/spiders/python-sidecar.py", import.meta.url));

pythonDescribe("Python NDJSON Spider engine", () => {
  it("runs sync and async Spider methods through an isolated RPC process", async () => {
    const sidecar = new PythonSidecar({
      pythonExecutable,
      script: fixture,
    });
    try {
      await sidecar.start();
      await expect(sidecar.init("local-fixture")).resolves.toMatchObject({ ok: true });
      await expect(sidecar.homeContent()).resolves.toMatchObject({
        ok: true,
        result: { list: [{ vod_id: "python-home" }] },
      });
      await expect(sidecar.searchContent("QX", true, 2)).resolves.toMatchObject({
        ok: true,
        result: { page: 2, list: [{ vod_name: "QX" }] },
      });
      await expect(sidecar.playerContent("main", "movie-1")).resolves.toMatchObject({
        ok: true,
        result: { url: "https://media.example.invalid/python.mp4" },
      });
    } finally {
      await sidecar.destroy();
    }
    expect(sidecar.isRunning).toBe(false);
    expect(sidecar.status).toBe("stopped");
  });

  it("maps a missing Python executable to a clear capability error", async () => {
    const sidecar = new PythonSidecar({
      pythonExecutable: "qx-python-does-not-exist",
      script: fixture,
      startupTimeoutMs: 500,
    });
    await expect(sidecar.start()).rejects.toMatchObject({ code: "PYTHON_NOT_FOUND" });
    await sidecar.destroy();
  });

  it("kills the whole Python sidecar when a request times out", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-python-timeout-"));
    const script = join(directory, "timeout.py");
    writeFileSync(script, `
import json, sys, time
print(json.dumps({"type":"ready","protocol":"python-spider-rpc/1"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "init":
        result = {"initialized": True}
    elif request["method"] == "home":
        time.sleep(2)
        result = {"list": []}
    else:
        result = {"destroyed": True}
    print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
`);
    const sidecar = new PythonSidecar({ pythonExecutable, script, requestTimeoutMs: 50 });
    try {
      await sidecar.start();
      await sidecar.init("fixture");
      await expect(sidecar.homeContent()).rejects.toMatchObject({ code: "PYTHON_TIMEOUT" });
      expect(sidecar.isRunning).toBe(false);
    } finally {
      await sidecar.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates Python client initialization and closes its process", async () => {
    const client = new PythonDesktopClient({
      api: "./python-sidecar.py",
      pythonExecutable,
      script: fixture,
    });
    try {
      const responses = await Promise.all([
        client.init("fixture"),
        client.init("fixture"),
      ]);
      expect(responses.every((response) => response.ok)).toBe(true);
    } finally {
      await client.destroy();
    }
    expect(client.isRunning).toBe(false);
  });

  it("downloads a Python URL source into a disposable sidecar workspace", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/x-python" });
      response.end(`
import json, sys
print(json.dumps({"type":"ready","protocol":"python-spider-rpc/1"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    result = {"initialized": True} if request["method"] == "init" else {"list": [{"vod_id": "url-python"}]}
    print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");
    const sidecar = new PythonSidecar({
      pythonExecutable,
      script: `http://127.0.0.1:${address.port}/spider.py`,
    });
    try {
      await sidecar.start();
      await expect(sidecar.init("url")).resolves.toMatchObject({ ok: true });
      await expect(sidecar.homeContent()).resolves.toMatchObject({
        ok: true,
        result: { list: [{ vod_id: "url-python" }] },
      });
    } finally {
      await sidecar.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
