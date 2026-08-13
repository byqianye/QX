import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { defaultConfigUrl } from "../src/spikes/config-probe.js";

const projectRoot = resolve(import.meta.dirname, "..");
const executable = resolve(projectRoot, process.argv[2] ?? "release/preview/win-unpacked/QX影视.exe");
if (!existsSync(executable)) throw new Error(`Preview executable is missing: ${executable}`);
const workDirectory = mkdtempSync(join(tmpdir(), "qx-packaged-android-playback-"));
const resultPath = join(workDirectory, "android-playback-result.json");
const keepWorkDirectory = process.env.QX_ANDROID_E2E_KEEP_TEMP === "1";
try {
  const result = await run(executable, workDirectory, {
    QX_ANDROID_PACKAGED_PLAYBACK: "1",
    QX_ANDROID_E2E_CONFIG_URL: process.env.QX_ANDROID_E2E_CONFIG_URL?.trim() || defaultConfigUrl,
    QX_ANDROID_E2E_KEYWORD: process.env.QX_ANDROID_E2E_KEYWORD?.trim() || "庆余年",
    QX_ANDROID_E2E_CONSENT: "1",
    QX_E2E_RESULT_PATH: resultPath,
    QX_E2E_USER_DATA: join(workDirectory, "user-data"),
  });
  const report = existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "";
  if (result.code !== 0 || !report.includes('"status": "PASS"')) {
    throw new Error(`Packaged Android playback failed: ${JSON.stringify({ result, report })}`);
  }
  console.log(report || result.stdout);
} finally {
  if (keepWorkDirectory) {
    console.error(`Packaged Android playback temp retained: ${workDirectory}`);
  } else {
    await removeWorkDirectory(workDirectory);
  }
}

async function removeWorkDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 5) {
        console.error(`Packaged Android playback temp cleanup deferred: ${directory}`, error);
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function run(executablePath: string, cwd: string, variables: Record<string, string>): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executablePath, [], {
      cwd,
      env: { ...process.env, ...variables },
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}
