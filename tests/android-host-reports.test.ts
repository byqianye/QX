import { describe, expect, it } from "vitest";

import {
  renderAndroidHostSetup,
  renderAndroidSpiderHostReport,
  renderAndroidSpiderPocV2,
  renderRuntimeDiagnosticsV4,
  type AndroidHostDiagnosticsReport,
} from "../src/spider/android-host-reports.js";

describe("Android Host reports V2/V4", () => {
  it("renders one evidence source with real Host gates", () => {
    const report: AndroidHostDiagnosticsReport = {
      generatedAt: "2026-08-09T00:00:00.000Z",
      configUrl: "https://example.test/config.json",
      siteKey: "feimao",
      siteName: "FeiMao",
      api: "csp_Duopan",
      keyword: "测试",
      status: "BLOCKED",
      environment: {
        sdkFound: true,
        sdkPath: "C:\\Android\\Sdk",
        adbFound: true,
        adbPath: "C:\\Android\\Sdk\\platform-tools\\adb.exe",
        deviceFound: false,
        hostApkFound: true,
        hostApkPath: "android-spider-host/app/build/outputs/apk/debug/app-debug.apk",
        hostInstalled: false,
        hostOnline: false,
        androidHostAvailable: false,
      },
      artifact: {
        url: "https://example.test/spider.jar",
        path: "C:\\cache\\spider.jar",
        size: 10,
        sha256: "a".repeat(64),
      },
      init: {
        status: "FAIL",
        durationMs: 12,
        initException: "missing Android context",
        contextDependent: true,
      },
      operations: {
        searchContent: { status: "NOT_RUN", keyword: "测试" },
        detailContent: { status: "NOT_RUN" },
        playerContent: { status: "NOT_RUN" },
      },
      blockers: ["ANDROID_DEVICE_NOT_FOUND"],
      notes: ["health is authoritative"],
    };
    expect(renderAndroidHostSetup(report)).toContain("ANDROID_DEVICE_NOT_FOUND");
    expect(renderAndroidSpiderPocV2(report)).toContain("csp_Duopan");
    expect(renderAndroidSpiderHostReport(report)).toContain("DexClassLoader");
    expect(renderAndroidHostSetup(report)).toContain("Android Host available: false");
    expect(renderAndroidSpiderPocV2(report)).toContain("initException=missing Android context");
    expect(renderAndroidSpiderPocV2(report)).toContain("contextDependent=true");
    expect(renderRuntimeDiagnosticsV4(report)).toContain("| RPC health | BLOCKED |");
    expect(renderRuntimeDiagnosticsV4(report)).not.toContain("android-spider-host.exe");
  });
});
