import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const mode = process.argv[2];
if (mode !== "mpv" && mode !== "sniffer") throw new Error("usage: tauri-runtime-canary.ts mpv|sniffer");
const executable = resolve(projectRoot, process.env.QX_TAURI_EXECUTABLE?.trim() || "src-tauri/target/release/qx-yingshi.exe");
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("TAURI_RUNTIME_CANARY_REQUIRES_WIN32_X64");
if (!existsSync(executable)) throw new Error(`TAURI_RUNTIME_CANARY_EXECUTABLE_MISSING: ${executable}`);

const directory = await mkdtemp(join(tmpdir(), `qx-tauri-${mode}-canary-`));
const resultPath = join(directory, "result.json");
const dataRoot = join(directory, "data");
const before = processSnapshot();
try {
  const result = await run(executable, [], {
    QX_TAURI_E2E: "1",
    QX_TAURI_E2E_DATA_ROOT: dataRoot,
    QX_TAURI_RUNTIME_CANARY: mode,
    QX_TAURI_CANARY_RESULT_PATH: resultPath,
  }, 120_000);
  const evidence = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown> : undefined;
  const noNewProcesses = await waitFor(() => noNewRuntimeProcesses(before), 8_000);
  const verified = result.code === 0 && evidence?.verified === true && noNewProcesses;
  const report = {
    ...(evidence ?? { schemaVersion: "v1", evidenceType: `tauri-${mode}-runtime-canary` }),
    verified,
    executable,
    process: { exitCode: result.code, signal: result.signal, noNewRuntimeProcesses: noNewProcesses },
    stdout: result.stdout.slice(-8_192),
    stderr: result.stderr.slice(-8_192),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!verified) throw new Error(`TAURI_RUNTIME_CANARY_FAILED: ${JSON.stringify(report)}`);
  const output = join(projectRoot, "artifacts", mode === "mpv" ? "tauri-mpv-runtime-canary.json" : "tauri-webview2-sniffer-runtime-canary.json");
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`TAURI_RUNTIME_CANARY_REPORT: ${output}`);
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
}

function processSnapshot(): Map<string, Set<number>> {
  const result = spawnSync("tasklist.exe", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  const snapshot = new Map<string, Set<number>>();
  if (result.status !== 0) return snapshot;
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = /^"([^"]+)","(\d+)"/u.exec(line.trim());
    if (!match) continue;
    const image = match[1]?.toLowerCase();
    const pid = Number(match[2]);
    if (!image || !Number.isInteger(pid) || !["qx-yingshi.exe", "qx-quickjs-sidecar.exe", "mpv.exe", "msedgewebview2.exe"].includes(image)) continue;
    const ids = snapshot.get(image) ?? new Set<number>();
    ids.add(pid);
    snapshot.set(image, ids);
  }
  return snapshot;
}

function noNewRuntimeProcesses(before: Map<string, Set<number>>): boolean {
  const current = processSnapshot();
  for (const [image, ids] of current) {
    const oldIds = before.get(image) ?? new Set<number>();
    for (const pid of ids) if (!oldIds.has(pid)) return false;
  }
  return true;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return predicate();
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], variables: Record<string, string>, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd: projectRoot, env: { ...process.env, ...variables }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (child.pid) spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}
