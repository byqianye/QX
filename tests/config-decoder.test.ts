import { Buffer } from "node:buffer";
import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  decodeConfigPayload,
  parseTvBoxConfig,
  summarizeConfig,
} from "../src/config/decoder.js";

const minimalConfig = {
  spider: "https://example.invalid/spider.jar",
  sites: [
    { key: "jar", name: "Jar", type: 3, api: "csp_Demo" },
    { key: "js", name: "JS", type: 3, api: "./demo.js" },
    { key: "py", name: "Python", type: 3, api: "./demo.py" },
    { key: "json", name: "JSON", type: 1, api: "https://example.invalid/api" },
  ],
  lives: [{ name: "Live", type: 0, url: "https://example.invalid/live.m3u" }],
};

describe("TVBox configuration boundary", () => {
  it("accepts plain JSON and produces a stable summary", () => {
    const config = parseTvBoxConfig(JSON.stringify(minimalConfig));

    expect(summarizeConfig(config)).toMatchObject({
      siteCount: 4,
      liveCount: 1,
      engineCounts: { java: 1, quickjs: 1, python: 1, http: 1 },
    });
  });

  it("decodes tvbox base64 payloads before parsing", () => {
    const encoded = `tvbox://${Buffer.from(JSON.stringify(minimalConfig)).toString("base64")}`;

    expect(parseTvBoxConfig(decodeConfigPayload(encoded))).toMatchObject({
      spider: minimalConfig.spider,
    });
  });

  it("rejects malformed or non-object configurations", () => {
    expect(() => parseTvBoxConfig("not-json")).toThrow(/JSON/);
    expect(() => parseTvBoxConfig(JSON.stringify([minimalConfig]))).toThrow(/object/);
  });

  it("decodes the FongMi AES-CBC envelope", () => {
    const plaintext = JSON.stringify({ sites: [{ key: "demo", api: "csp_Demo" }] });
    const encrypted = makeFongMiEnvelope(plaintext, "123456", "1234567890123");

    expect(parseTvBoxConfig(decodeConfigPayload(encrypted))).toEqual(JSON.parse(plaintext));
  });
});

function makeFongMiEnvelope(plaintext: string, password: string, ivText: string): string {
  const key = Buffer.from(password.padEnd(16, "0"), "latin1");
  const iv = Buffer.from(ivText.padEnd(16, "0"), "latin1");
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const decodedEnvelope = Buffer.concat([
    Buffer.from(`$#${password}#$`, "latin1"),
    ciphertext,
    Buffer.from(ivText, "latin1"),
  ]);

  return Buffer.from(decodedEnvelope).toString("hex");
}
