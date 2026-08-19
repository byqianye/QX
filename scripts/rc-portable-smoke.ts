import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { version?: string };
const version = packageJson.version ?? "";
const portable = resolve(process.env.QX_RC_PORTABLE_PATH ?? join(projectRoot, "release", "rc", `QX影视-RC-Portable-${version}-x64.exe`));
if (!existsSync(portable)) throw new Error(`RC Portable artifact is missing: ${portable}`);
const result = await run(process.execPath, [join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"), join(projectRoot, "scripts", "preview-smoke.ts"), portable], {});
if (result.code !== 0) throw new Error(`RC Portable smoke failed: ${JSON.stringify(result)}`);
writeFileSync(join(projectRoot, "docs/reports/testing/WINDOWS-RC-PORTABLE-TEST.md"), `# Windows RC Portable Smoke\n\n\`PORTABLE = PASS\`\n\nArtifact: ${portable}\n\n\`\`\`json\n${result.stdout.trim()}\n\`\`\`\n`, "utf8");
console.log(result.stdout);

function run(executable: string, args: string[], variables: Record<string, string>): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: projectRoot, env: { ...process.env, ...variables }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}
