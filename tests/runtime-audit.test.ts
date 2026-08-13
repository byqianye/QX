import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { RuntimeAuditService } from "../src/spider/runtime-audit-service.js";
import { renderRuntimeAuditMarkdown } from "../src/spider/runtime-audit-report.js";

describe("RuntimeAuditService", () => {
  it("classifies every configured site into the standard audit shape", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-runtime-audit-"));
    const dexPath = join(directory, "android.jar");
    const jvmPath = join(directory, "jvm.jar");
    const brokenPath = join(directory, "broken.jar");
    writeFileSync(dexPath, zipFile(["classes.dex", "assets/config.json"]));
    writeFileSync(jvmPath, zipFile(["com/example/Spider.class"]));
    writeFileSync(brokenPath, "not-a-zip");
    try {
      const report = await new RuntimeAuditService({
        python: { available: false },
      }).audit({
        spider: dexPath,
        sites: [
          { key: "xml", name: "XML", type: 0, api: "https://xml.example.test" },
          { key: "json", name: "JSON", type: 1, api: "https://json.example.test" },
          { key: "native", name: "Native", type: 3, api: "csp_Douban" },
          { key: "js", name: "JS", type: 3, api: "js:export default {}" },
          { key: "py", name: "Python", type: 3, api: "py:https://example.test/spider.py" },
          { key: "dex", name: "DEX", type: 3, api: "csp_Dex" },
          { key: "jvm", name: "JVM", type: 3, api: "csp_Jvm", jar: jvmPath },
          { key: "broken", name: "Broken", type: 3, api: "csp_Broken", jar: brokenPath },
        ],
      });

      expect(report.sites).toHaveLength(8);
      expect(report.sites).toEqual(expect.arrayContaining([
        expect.objectContaining({ siteKey: "xml", runtime: "cms-xml", supported: true }),
        expect.objectContaining({ siteKey: "json", runtime: "cms-json", supported: true }),
        expect.objectContaining({ siteKey: "native", runtime: "native", supported: true }),
        expect.objectContaining({ siteKey: "js", runtime: "javascript", supported: true }),
        expect.objectContaining({ siteKey: "py", runtime: "python", supported: false, reason: "python_runtime_missing" }),
        expect.objectContaining({ siteKey: "dex", runtime: "android-dex", supported: true, reason: "android_dex_artifact_ready" }),
        expect.objectContaining({ siteKey: "jvm", runtime: "jvm-jar", supported: true }),
        expect.objectContaining({ siteKey: "broken", runtime: "unknown", supported: false, reason: "invalid_jar" }),
      ]));
      for (const site of report.sites) {
        expect(site).toEqual(expect.objectContaining({
          siteKey: expect.any(String),
          siteName: expect.any(String),
          type: expect.any(Number),
          api: expect.any(String),
          runtime: expect.any(String),
          searchable: expect.any(Boolean),
          supported: expect.any(Boolean),
          capabilities: {
            home: expect.any(Boolean),
            category: expect.any(Boolean),
            search: expect.any(Boolean),
            detail: expect.any(Boolean),
            player: expect.any(Boolean),
          },
        }));
      }
      expect(report.summary).toMatchObject({
        totalSites: 8,
        searchableSites: 8,
        searchableSupportedSites: 6,
        runtimeCounts: {
          "cms-xml": 1,
          "cms-json": 1,
          native: 1,
          javascript: 1,
          python: 1,
          "android-dex": 1,
          "jvm-jar": 1,
          unknown: 1,
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders the Android DEX gate from the audit summary", () => {
    const markdown = renderRuntimeAuditMarkdown({
      generatedAt: "2026-08-08T00:00:00.000Z",
      sites: [],
      artifacts: [],
      summary: {
        totalSites: 5,
        searchableSites: 5,
        supportedSites: 0,
        searchableSupportedSites: 0,
        runtimeCounts: {
          "cms-json": 0,
          "cms-xml": 0,
          native: 0,
          javascript: 0,
          "android-dex": 4,
          "jvm-jar": 0,
          python: 0,
          unknown: 1,
        },
        unsupportedReasons: {},
      },
    });
    expect(markdown).toContain("Proceed to G83 Android DEX PoC.");
  });
});

function zipFile(names: readonly string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const filename = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(filename.length, 26);
    filename.copy(local, 30);
    locals.push(local);

    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    filename.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}
