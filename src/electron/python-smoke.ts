import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PythonDesktopClient } from "../spider/python-client.js";
import { sanitizedPackagedPythonEnvironment } from "./runtime.js";

const runtimeDirectory = process.env.QX_RUNTIME_DIRECTORY?.trim()
  || join(process.cwd(), "dist", "electron-runtime");
const pythonExecutable = join(runtimeDirectory, "python", "python.exe");
const fixture = fileURLToPath(new URL("../../fixtures/spiders/python-sidecar.py", import.meta.url));

if (!existsSync(pythonExecutable)) {
  throw new Error(`Bundled Python is unavailable: ${pythonExecutable}`);
}

const environment = sanitizedPackagedPythonEnvironment({
  ...process.env,
  PYTHONHOME: "C:\\qx-malicious-python-home",
  PYTHONPATH: "C:\\qx-malicious-python-path",
  PYTHONUSERBASE: "C:\\qx-malicious-python-userbase",
  VIRTUAL_ENV: "C:\\qx-malicious-python-venv",
});
const client = new PythonDesktopClient({
  api: "bundled-python-fixture",
  pythonExecutable,
  script: fixture,
  env: environment,
});
let pid: number | null = null;

try {
  const initialized = await client.init("bundled-python");
  pid = client.pid;
  if (!pid) throw new Error("Bundled Python sidecar did not expose a process id");
  const home = await client.homeContent();
  const search = await client.searchContent("QX", true, 2);
  if (!initialized.ok || !home.ok || !search.ok) {
    throw new Error(`Bundled Python returned an error: ${JSON.stringify({ initialized, home, search })}`);
  }
  if (!home.result || !search.result) throw new Error("Bundled Python returned no result payload");
  console.log(JSON.stringify({
    probe: "bundled-python-smoke",
    status: "passed",
    pythonExecutable,
    pid,
    home: home.result,
    search: search.result,
    sanitizedVariables: ["PYTHONHOME", "PYTHONPATH", "PYTHONUSERBASE", "VIRTUAL_ENV"]
      .filter((name) => environment[name] === undefined),
  }, null, 2));
} finally {
  await client.destroy();
  if (client.isRunning) throw new Error("Bundled Python sidecar did not stop");
}
