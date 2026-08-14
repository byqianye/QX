import { once } from "node:events";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");
const profile = process.argv.includes("--release") ? "release" : "debug";
const binary = join(projectRoot, "src-tauri", "quickjs-sidecar", "target", profile, `qx-quickjs-sidecar${process.platform === "win32" ? ".exe" : ""}`);
if (!existsSync(binary)) throw new Error(`Missing sidecar binary: ${binary}`);

const child = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
const lines = createInterface({ input: child.stdout });
const iterator = lines[Symbol.asyncIterator]();

async function request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  const next = await iterator.next();
  if (next.done) throw new Error("QuickJS sidecar exited before returning a response");
  const response = JSON.parse(next.value) as Record<string, unknown>;
  if (response.ok !== true) throw new Error(`Sidecar request failed: ${JSON.stringify(response)}`);
  return response;
}

await request({
  id: "load",
  method: "load",
  script: "import { marker } from './dep.js'; export default { home(){ return { list: [] }; }, sum(a,b){ return a+b; }, marker(){ return marker; }, loop(){ while (true) {} } };",
  moduleSources: { "dep.js": "export const marker = 'module-ok';" },
  allowedOrigins: [],
});
const sum = await request({ id: "sum", method: "call", name: "sum", args: [2, 5] });
if (sum.result !== 7) throw new Error(`Unexpected sum result: ${JSON.stringify(sum)}`);
const marker = await request({ id: "marker", method: "call", name: "marker", args: [] });
if (marker.result !== "module-ok") throw new Error(`Unexpected module result: ${JSON.stringify(marker)}`);
const capabilities = await request({ id: "capabilities", method: "capabilities" });
const capabilityResult = capabilities.result as Record<string, boolean>;
if (capabilityResult.home !== true || capabilityResult.player !== false || "missing" in capabilityResult) {
  throw new Error(`Unexpected capability result: ${JSON.stringify(capabilities)}`);
}

child.stdin.write(`${JSON.stringify({ id: "timeout", method: "call", name: "loop", args: [] })}\n`);
const timeoutResponse = JSON.parse((await iterator.next()).value as string) as Record<string, unknown>;
const timeoutError = timeoutResponse.error as { code?: string } | undefined;
if (timeoutResponse.ok !== false || timeoutError?.code !== "QUICKJS_TIMEOUT") {
  throw new Error(`Expected QUICKJS_TIMEOUT, received ${JSON.stringify(timeoutResponse)}`);
}

await request({ id: "close", method: "close" });
const [code] = await once(child, "close") as [number | null];
if (code !== 0) throw new Error(`QuickJS sidecar did not exit cleanly: ${String(code)}`);
console.log(`QuickJS sidecar canary passed (${profile})`);
