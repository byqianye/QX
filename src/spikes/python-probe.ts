import { createInterface } from "node:readline";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { resolve } from "node:path";

import { createSpiderRequest } from "../spider/rpc.js";

export async function runPythonProbe() {
  const python = process.env.QX_PYTHON ?? "python";
  const child = spawn(python, [resolve("fixtures/spiders/python-sidecar.py")], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  try {
    const ready = await readReadyLine(child);
    const baseUrl = `http://127.0.0.1:${ready.port}`;
    const init = await call(baseUrl, createSpiderRequest("init", { ext: "local-fixture" }, "py-init"));
    const home = await call(baseUrl, createSpiderRequest("home", {}, "py-home"));
    const search = await call(
      baseUrl,
      createSpiderRequest("search", { wd: "QX", quick: true }, "py-search"),
    );

    return {
      probe: "python",
      passed: init.ok && home.ok && search.ok,
      bridge: "http",
      responses: { init, home, search },
    };
  } finally {
    child.kill();
  }
}

async function call(baseUrl: string, request: object) {
  const response = await fetch(`${baseUrl}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Python sidecar failed: HTTP ${response.status}`);
  return response.json();
}

function readReadyLine(child: ChildProcessByStdio<null, Readable, Readable>): Promise<{ port: number }> {
  return new Promise((resolveReady, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      lines.close();
      reject(new Error("Python sidecar did not become ready within 10 seconds"));
    }, 10_000);

    lines.once("line", (line) => {
      clearTimeout(timer);
      lines.close();
      try {
        const value: unknown = JSON.parse(line);
        if (!isRecord(value) || value.ready !== true || typeof value.port !== "number") {
          reject(new Error("Python sidecar returned an invalid ready message"));
          return;
        }
        resolveReady({ port: value.port });
      } catch (error) {
        reject(new Error("Python sidecar ready message is not valid JSON", { cause: error }));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      lines.close();
      reject(error);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (isMain()) {
  runPythonProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}

function isMain(): boolean {
  return process.argv[1]?.endsWith("python-probe.ts") ?? false;
}
