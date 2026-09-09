import { describe, expect, it } from "vitest";

import { normalizeRuntimeError, runtimeErrorMessage } from "../src/spider/runtime-errors.js";

describe("runtime error normalization", () => {
  it("turns ENOENT into an actionable artifact diagnostic", () => {
    const error = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
      syscall: "open",
      path: "C:\\Users\\user\\spider-cache\\artifact.jar",
    });
    const details = normalizeRuntimeError(error, {
      runtimeKind: "jvm",
      siteKey: "flash",
      sourceName: "Flash source",
      artifactUrl: "https://example.test/spider.jar",
      artifactPath: "C:\\Users\\user\\spider-cache\\artifact.jar",
      workingDirectory: "C:\\Program Files\\QX影视",
      isPackaged: true,
      resourcesPath: "C:\\Program Files\\QX影视\\resources",
    });

    expect(details).toMatchObject({
      code: "artifact_file_missing",
      syscall: "open",
      missingPath: "C:\\Users\\user\\spider-cache\\artifact.jar",
      siteKey: "flash",
      runtime: "jvm",
      artifactUrl: "https://example.test/spider.jar",
      artifactPath: "C:\\Users\\user\\spider-cache\\artifact.jar",
      workingDirectory: "C:\\Program Files\\QX影视",
      isPackaged: true,
    });
    expect(runtimeErrorMessage(details)).toContain("rootCause=artifact_file_missing");
    expect(runtimeErrorMessage(details)).not.toBe("ENOENT");
  });

  it("distinguishes missing runtime host from missing artifact", () => {
    const error = Object.assign(new Error("spawn host ENOENT"), {
      code: "ENOENT",
      syscall: "spawn",
      path: "C:\\Program Files\\QX影视\\resources\\jvm-spider-host.exe",
    });
    const details = normalizeRuntimeError(error, {
      runtimeKind: "jvm",
      rootCause: "runtime_host_missing",
    });
    expect(details.code).toBe("runtime_host_missing");
    expect(details.message).toContain("Spider runtime host is missing");
  });
});
