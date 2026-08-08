import { describe, expect, it } from "vitest";

import {
  renderAndroidBridgeFeasibility,
  renderAndroidSpiderPoc,
  renderEnoentAudit,
  renderRuntimeDiagnosticsV3,
  type AndroidSpiderPocReport,
} from "../src/spider/android-spider-reports.js";

describe("Android Spider reports", () => {
  it("documents a blocked real-source PoC without hiding the root cause", () => {
    const report: AndroidSpiderPocReport = {
      generatedAt: "2026-08-08T00:00:00.000Z",
      configUrl: "https://example.test/config.json",
      siteKey: "flash",
      siteName: "Flash",
      api: "csp_Flash",
      artifactUrl: "https://example.test/spider.jar",
      artifactPath: "C:\\Users\\user\\cache\\spider.jar",
      artifact: {
        url: "https://example.test/spider.jar",
        sha256: "a".repeat(64),
        size: 12,
        format: "jar",
        hasClassesDex: true,
        hasJvmClasses: false,
        dexCount: 1,
        classCount: 0,
        nativeLibraries: [],
        assets: [],
        runtimeRequirement: "android-dex",
      },
      environment: {
        adbPath: "adb",
        adbDevices: "List of devices attached",
        connectedDevice: false,
        androidSdkAvailable: false,
        javaCompilerAvailable: false,
        hostAvailable: false,
      },
      status: "BLOCKED",
      attempts: [
        { operation: "searchContent", status: "not_run" },
        { operation: "detailContent", status: "not_run" },
        { operation: "playerContent", status: "not_run" },
      ],
      blockers: ["runtime_host_missing"],
      normalizedError: {
        code: "runtime_host_missing",
        message: "Spider runtime host is missing",
        syscall: "spawn",
        missingPath: "C:\\Users\\user\\android-spider-host.exe",
        sourceKey: "flash",
        sourceName: "Flash",
        runtime: "android-dex",
        artifactUrl: "https://example.test/spider.jar",
        artifactPath: "C:\\Users\\user\\cache\\spider.jar",
      },
    };
    const audit = {
      generatedAt: report.generatedAt,
      sourceUrl: report.configUrl,
      sites: [{
        siteKey: "flash",
        siteName: "Flash",
        type: 3,
        api: "csp_Flash",
        runtime: "android-dex" as const,
        searchable: true,
        supported: false,
        reason: "android_dex_runtime_not_available",
        capabilities: { home: false, category: false, search: false, detail: false, player: false },
      }],
      summary: {
        totalSites: 1,
        searchableSites: 1,
        supportedSites: 0,
        searchableSupportedSites: 0,
        runtimeCounts: { "cms-json": 0, "cms-xml": 0, native: 0, javascript: 0, "android-dex": 1, "jvm-jar": 0, python: 0, unknown: 0 },
        unsupportedReasons: { android_dex_runtime_not_available: 1 },
      },
      artifacts: [],
    };
    expect(renderAndroidBridgeFeasibility(report)).toContain("BLOCKED");
    expect(renderAndroidSpiderPoc(report)).toContain("runtime_host_missing");
    expect(renderEnoentAudit(report, audit)).toContain("missingPath");
    expect(renderRuntimeDiagnosticsV3(report, audit)).toContain("Searchable supported: 0");
  });
});
