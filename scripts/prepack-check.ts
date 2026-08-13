import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = join(projectRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  version?: unknown;
  main?: unknown;
};
const failures: string[] = [];

check("package.json version", typeof packageJson.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(packageJson.version), String(packageJson.version));
check("main entry", typeof packageJson.main === "string" && existsSync(join(projectRoot, packageJson.main)), String(packageJson.main));
check("renderer build", existsSync(join(projectRoot, "dist", "renderer", "index.html")), "dist/renderer/index.html");
check("application icon", existsSync(join(projectRoot, "build", "assets", "qx-yingshi.ico")), "build/assets/qx-yingshi.ico");

const runtimeDirectory = join(projectRoot, "dist", "electron-runtime");
const runtimeManifestPath = join(runtimeDirectory, "runtime-manifest.json");
check("bundled runtime manifest", existsSync(runtimeManifestPath), runtimeManifestPath);
if (existsSync(runtimeManifestPath)) {
  const manifest = JSON.parse(readFileSync(runtimeManifestPath, "utf8")) as {
    runtimes?: Record<string, { bundled?: unknown; executable?: unknown }>;
  };
  for (const id of ["jre", "python", "mpv", "aria2"]) {
    const entry = manifest.runtimes?.[id];
    check(`${id} bundled`, entry?.bundled === true, "manifest bundled=true");
    check(`${id} executable`, typeof entry?.executable === "string" && existsSync(join(runtimeDirectory, entry.executable)), String(entry?.executable));
  }
  check("JVM host artifact", existsSync(join(runtimeDirectory, "jvm-spider-host.jar")), "jvm-spider-host.jar");
  check("JVM spider artifact", existsSync(join(runtimeDirectory, "jvm-spiders.jar")), "jvm-spiders.jar");
}

const productionRoots = [join(projectRoot, "dist", "electron"), join(projectRoot, "dist", "renderer")];
for (const root of productionRoots) {
  if (!existsSync(root)) continue;
  for (const file of walkFiles(root)) {
    if (!isTextFile(file)) continue;
    const text = readFileSync(file, "utf8");
    if (/(?:[A-Z]:\\(?:Users|Project)\\)/iu.test(text)) {
      failures.push(`development absolute path in ${file}`);
    }
    if (/localhost:(?:3000|5173)\b/iu.test(text)) {
      failures.push(`development server URL in ${file}`);
    }
  }
}

const releaseDirectory = join(projectRoot, "release");
try {
  mkdirSync(releaseDirectory, { recursive: true });
  const probe = join(releaseDirectory, `.prepack-check-${process.pid}.tmp`);
  writeFileSync(probe, "ok", { flag: "wx" });
  unlinkSync(probe);
} catch (error) {
  failures.push(`release directory is not writable: ${errorMessage(error)}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`prepack-check: FAIL ${failure}`);
  process.exit(1);
}

console.log("prepack-check: PASS");

function check(label: string, condition: boolean, expected: string): void {
  if (!condition) failures.push(`${label} missing or invalid (${expected})`);
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function isTextFile(path: string): boolean {
  return new Set([".js", ".json", ".html", ".css", ".txt"]).has(extname(path).toLowerCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
