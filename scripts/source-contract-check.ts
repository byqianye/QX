import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Check = { name: string; command: string; args: string[]; status: "PASS" | "FAIL"; durationMs: number; output: string };

const root = resolve(import.meta.dirname, "..");
const checks: Check[] = [];

async function run(name: string, command: string, args: string[]): Promise<void> {
  const started = Date.now();
  const output: string[] = [];
  const status = await new Promise<"PASS" | "FAIL">((resolveStatus) => {
    const executable = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
    const child = spawn(executable, args, { cwd: root, shell: true });
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    child.on("error", (error) => {
      output.push(String(error));
      resolveStatus("FAIL");
    });
    child.on("close", (code) => resolveStatus(code === 0 ? "PASS" : "FAIL"));
  });
  checks.push({ name, command, args, status, durationMs: Date.now() - started, output: output.join("").slice(-4000) });
  if (status === "FAIL") throw new Error(`${name} failed`);
}

await run("declarative adapter tests", "npm", ["exec", "vitest", "run", "tests/source-compatibility-v2.test.ts", "tests/source-contract.test.ts", "--", "--maxWorkers=1", "--minWorkers=1", "--reporter=dot"]);
await run("Rust declarative converter tests", "cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "source_converter::tests", "--", "--nocapture", "--test-threads=1"]);

const artifact = {
  schemaVersion: "v1",
  evidenceType: "source-contract-check",
  generatedAt: new Date().toISOString(),
  checks,
  summary: { passed: checks.filter((check) => check.status === "PASS").length, failed: checks.filter((check) => check.status === "FAIL").length },
};
await mkdir(resolve(root, "artifacts"), { recursive: true });
await writeFile(resolve(root, "artifacts/source-contract-check.json"), JSON.stringify(artifact, null, 2));
console.log(`Source contract checks passed: ${artifact.summary.passed}`);
