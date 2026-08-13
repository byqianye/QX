import { describe, expect, it } from "vitest";

import {
  isPinnedTemurin,
  jlinkArguments,
  MINIMAL_JRE_MODULES,
  PINNED_TEMURIN,
} from "../src/electron/jre.js";

describe("Spike18 bundled JRE specification", () => {
  it("pins the Windows x64 Temurin toolchain", () => {
    expect(PINNED_TEMURIN).toMatchObject({
      distribution: "Eclipse Temurin",
      version: "21.0.7+6",
      platform: "windows-x64",
    });
    expect(PINNED_TEMURIN.sha256).toHaveLength(64);
  });

  it("builds the minimal JRE with the required modules and size flags", () => {
    expect(MINIMAL_JRE_MODULES).toEqual(["java.base", "java.net.http", "java.xml", "java.logging", "java.desktop", "jdk.crypto.ec"]);
    expect(jlinkArguments("C:\\runtime\\jre")).toEqual([
      "--add-modules",
      "java.base,java.net.http,java.xml,java.logging,java.desktop,jdk.crypto.ec",
      "--strip-debug",
      "--no-man-pages",
      "--no-header-files",
      "--compress=2",
      "--output",
      "C:\\runtime\\jre",
    ]);
  });

  it("recognizes the pinned Temurin runtime and rejects another vendor", () => {
    expect(isPinnedTemurin({
      vendor: "Eclipse Adoptium",
      version: "21.0.7+6-LTS",
      dataModel: "64",
      output: "",
    })).toBe(true);
    expect(isPinnedTemurin({
      vendor: "Oracle Corporation",
      version: "21.0.7+8-LTS-245",
      dataModel: "64",
      output: "",
    })).toBe(false);
  });
});
