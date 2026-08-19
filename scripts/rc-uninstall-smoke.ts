import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { version?: string };
const version = packageJson.version ?? "";
const installer = resolve(process.env.QX_RC_INSTALLER_PATH ?? join(projectRoot, "release", "rc", `QX影视-RC-Setup-${version}-x64.exe`));
if (!existsSync(installer)) throw new Error(`RC installer is missing: ${installer}`);

const result = await run(process.execPath, [join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"), join(projectRoot, "src", "electron", "installer-e2e.ts")], {
  QX_INSTALLER_PATH: installer,
  QX_INSTALLER_MENU_CATEGORY: "QX影视",
});
if (result.code !== 0) throw new Error(`RC uninstall smoke failed: ${JSON.stringify(result)}`);
const output = result.stdout.trim();
if (!output.includes('"userDataRetained": true')) throw new Error("RC uninstall smoke did not prove user data retention");
writeFileSync(join(projectRoot, "docs/reports/testing/WINDOWS-RC-UNINSTALL-TEST.md"), `# Windows RC Uninstall Smoke\n\n\`UNINSTALL = PASS\`\n\nUser data was retained by the default silent uninstall.\n\n\`\`\`json\n${output}\n\`\`\`\n`, "utf8");
console.log(output);

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
