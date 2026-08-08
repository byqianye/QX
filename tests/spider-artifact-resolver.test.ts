import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { SpiderArtifactCache } from "../src/spider/spider-artifact-cache.js";
import { SpiderArtifactResolver } from "../src/spider/spider-artifact-resolver.js";

describe("SpiderArtifactResolver", () => {
  it("resolves a relative artifact against an HTTP config URL", () => {
    const result = new SpiderArtifactResolver().resolve(
      { key: "flash", type: 3, api: "csp_Flash" },
      { spider: "./jar/spider.jar" },
      "https://example.test/config/config.json",
    );
    expect(result).toMatchObject({
      spiderUrl: "https://example.test/config/jar/spider.jar",
      jarUrl: "https://example.test/config/jar/spider.jar",
    });
  });

  it("returns an absolute local path, hash, size, and cache metadata for a file declaration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-artifact-resolver-"));
    const configPath = join(directory, "config.json");
    const artifactPath = join(directory, "spider.jar");
    writeFileSync(configPath, "{}");
    writeFileSync(artifactPath, "artifact-fixture");
    try {
      const resolved = await new SpiderArtifactResolver().resolveSpiderArtifact(
        pathToFileURL(configPath).toString(),
        `./spider.jar;md5;${createHash("md5").update("artifact-fixture").digest("hex")}`,
        new SpiderArtifactCache(join(directory, "cache")),
      );
      expect(resolved).toMatchObject({
        localPath: artifactPath,
        size: Buffer.byteLength("artifact-fixture"),
        cacheHit: true,
      });
      expect(resolved.sha256).toMatch(/^[\da-f]{64}$/u);
      expect(resolved.artifactUrl).toBe(pathToFileURL(artifactPath).toString());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
