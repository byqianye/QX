import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const output = join(root, "dist", "release-inventory");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
  packages?: Record<string, { version?: string; resolved?: string; license?: string } | undefined>;
};
const runtimeManifest = join(root, "dist", "electron-runtime", "runtime-manifest.json");

if (!existsSync(runtimeManifest)) throw new Error("Build the bundled runtime before generating release inventory");

await mkdir(output, { recursive: true });
await copyFile(runtimeManifest, join(output, "runtime-manifest.json"));
const runtime = JSON.parse(readFileSync(runtimeManifest, "utf8")) as {
  runtimes: Record<string, {
    bundled: boolean;
    version: string;
    license: string;
    source: string;
    archiveSha256: string;
    licenseFiles: readonly string[];
  }>;
};
const npmComponents = Object.entries(lock.packages ?? {})
  .filter(([path, value]) => path.startsWith("node_modules/") && value?.version)
  .map(([path, value]) => {
    const name = path.slice("node_modules/".length);
    const production = packageJson.dependencies?.[name] !== undefined;
    const development = packageJson.devDependencies?.[name] !== undefined;
    return {
      type: "library",
      name,
      version: value!.version,
      scope: production ? "required" : development ? "development" : "optional",
      ...(value!.resolved ? { purl: `pkg:npm/${encodeURIComponent(name)}@${value!.version}` } : {}),
      ...(value!.license
        ? { licenses: [{ license: { id: value!.license } }] }
        : { properties: [{ name: "qx:licenseStatus", value: "unknown-until-legal-review" }] }),
    };
  });
const runtimeComponents = Object.entries(runtime.runtimes).map(([id, value]) => ({
  type: "file",
  name: `qx-runtime-${id}`,
  version: value.version,
  scope: value.bundled ? "required" : "optional",
  hashes: [{ alg: "SHA-256", content: value.archiveSha256 }],
  licenses: [{ license: { id: value.license } }],
  externalReferences: [{ type: "distribution", url: value.source }],
  properties: value.licenseFiles.map((path) => ({ name: "qx:licenseFile", value: path })),
}));
await writeFile(join(output, "sbom.cdx.json"), `${JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    component: {
      type: "application",
      name: packageJson.name,
      version: packageJson.version,
    },
  },
  components: [...npmComponents, ...runtimeComponents],
}, null, 2)}\n`, "utf8");

const notices = [
  "QX影视 third-party notices",
  "",
  "This file is generated for the release artifact. Consult the bundled files and source URLs for complete license text.",
  "",
  "Eclipse Temurin 21.0.7+6 — GPLv2 with Classpath Exception; bundled notice: electron-runtime/jre/NOTICE and electron-runtime/jre/legal/.",
  "CPython 3.12.10 embeddable — PSF License; bundled notice: electron-runtime/python/LICENSE.txt.",
  "aria2 1.37.0 — GPLv2; bundled notices: electron-runtime/aria2/COPYING and electron-runtime/aria2/LICENSE.OpenSSL.",
  "mpv fixed build 21277b0ccf — GPLv2 or later; source release: https://github.com/zhongfly/mpv-winbuild/releases/tag/2026-08-07-21277b0ccf.",
  "Electron, Vue, Vite and other npm dependencies — see sbom.cdx.json and package-lock.json for the exact resolved inventory.",
];
await writeFile(join(output, "THIRD_PARTY_NOTICES.txt"), `${notices.join("\n")}\n`, "utf8");

const commit = safeGitCommit();
await writeFile(join(output, "build-metadata.json"), `${JSON.stringify({
  productName: "QX影视",
  packageName: packageJson.name,
  version: packageJson.version,
  target: "windows-x64",
  commit,
  nodeVersion: process.version,
  generatedAt: new Date().toISOString(),
}, null, 2)}\n`, "utf8");

console.log(`release inventory: ${output}`);

function safeGitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
