import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const failures: string[] = [];
const warnings: string[] = [];
const allowIncomplete = process.argv.includes("--allow-incomplete");

const packageJson = readJson(join(root, "package.json")) as { version?: string };
const tauriConfig = readJson(join(root, "src-tauri", "tauri.conf.json")) as {
  identifier?: string;
  bundle?: { targets?: string[] };
};

check("Tauri identifier", tauriConfig.identifier === "com.qx.yingshi.desktop");
check("Tauri NSIS target", tauriConfig.bundle?.targets?.includes("nsis") === true);
check("package semver", typeof packageJson.version === "string" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(packageJson.version));
check("G107 report exists", existsSync(join(root, "G107-BASELINE-REPORT.md")));
check("G108 report exists", existsSync(join(root, "G108-REPORT.md")));
check("G109 report exists", existsSync(join(root, "G109-REPORT.md")));
check("G110 report exists", existsSync(join(root, "G110-REPORT.md")));
check("G111 report exists", existsSync(join(root, "G111-REPORT.md")));
check("old Electron remains during migration", existsSync(join(root, "src", "electron", "main.ts")));
check("Tauri backend remains", existsSync(join(root, "src-tauri", "src", "lib.rs")));

const installer = process.env.QX_TAURI_NSIS ?? join(root, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "bundle", "nsis", "QX影视_0.9.0_x64-setup.exe");
if (existsSync(installer)) {
  check("NSIS <= 20 MiB", statSync(installer).size <= 20 * 1024 * 1024, `${statSync(installer).size} bytes`);
} else {
  warnings.push(`NSIS artifact not found: ${installer}`);
}

for (const report of ["G108-REPORT.md", "G109-REPORT.md", "G110-REPORT.md", "G111-REPORT.md"]) {
  const text = readFileSync(join(root, report), "utf8");
  if (/Status:\s*in progress/iu.test(text)) {
    const message = `${report} is still in progress`;
    if (allowIncomplete) warnings.push(message);
    else failures.push(message);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`g112-release-gate: FAIL ${failure}`);
  for (const warning of warnings) console.error(`g112-release-gate: WARN ${warning}`);
  process.exit(1);
}

for (const warning of warnings) console.warn(`g112-release-gate: WARN ${warning}`);
console.log(`g112-release-gate: PASS structural checks${allowIncomplete ? " (incomplete override)" : ""}`);

function check(label: string, condition: boolean, detail?: string): void {
  if (!condition) failures.push(`${label}${detail ? ` (${detail})` : ""}`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
