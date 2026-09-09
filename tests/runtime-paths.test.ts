import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { ProductionLogger } from "../src/electron/production-logger.js";
import { RuntimePathResolver } from "../src/electron/runtime-paths.js";

describe("packaged runtime paths and production logging", () => {
  const directories: string[] = [];

  afterEach(() => {
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("separates development output from packaged resources and user data", () => {
    const development = new RuntimePathResolver({
      appPath: "C:\\project",
      resourcesPath: "C:\\project\\resources",
      userDataPath: "C:\\Users\\user\\AppData\\Roaming\\QX影视",
      isPackaged: false,
    });
    expect(development.getRuntimePath()).toBe(join("C:\\project", "dist", "electron-runtime"));
    expect(development.getRendererPath()).toBe(join("C:\\project", "dist", "renderer"));
    expect(development.getCachePath()).toContain(join("QX影视", "cache"));

    const packaged = new RuntimePathResolver({
      appPath: "C:\\Program Files\\QX影视\\resources\\app.asar",
      resourcesPath: "C:\\Program Files\\QX影视\\resources",
      userDataPath: "C:\\Users\\user\\AppData\\Roaming\\QX影视",
      isPackaged: true,
    });
    expect(packaged.getRuntimePath()).toBe(join("C:\\Program Files\\QX影视\\resources", "electron-runtime"));
    expect(packaged.getRendererPath()).toContain(join("app.asar", "dist", "renderer"));
    expect(packaged.getBrandIconCandidates()[0]).toBe(join("C:\\Program Files\\QX影视\\resources", "brand", "qx-yingshi.ico"));
  });

  it("redacts sensitive values and rotates bounded logs", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-production-log-"));
    directories.push(directory);
    const logger = new ProductionLogger({ directory, maxBytes: 1_024, maxFiles: 2 });
    logger.error("FATAL_ERROR", new Error("token=secret-value"), {
      token: "secret-value",
      message: "authorization=private-value",
    });
    logger.info("APP_START", { payload: "x".repeat(1_500), mediaUrl: "https://media.example.invalid/episode.m3u8" });
    logger.info("APP_START", { payload: "y".repeat(1_500) });

    const current = readFileSync(join(directory, "main.log"), "utf8");
    expect(current).not.toContain("secret-value");
    expect(current).not.toContain("private-value");
    expect(readFileSync(join(directory, "main.log.1"), "utf8")).toContain("APP_START");
    expect(current).not.toContain("https://media.example.invalid/episode.m3u8");
  });

});
