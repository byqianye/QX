import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Windows Preview packaging configuration", () => {
  it("keeps Preview artifact names without Android Host resources", () => {
    const config = readFileSync(new URL("../electron-builder.preview.yml", import.meta.url), "utf8");
    expect(config).toContain("output: release/preview");
    expect(config).toContain("asar: true");
    expect(config).not.toContain("android-spider-host");
    expect(config).not.toContain("android-runtime");
    expect(config).toContain("QX影视-Preview-Setup-${version}-${arch}.${ext}");
    expect(config).toContain("QX影视-Preview-Portable-${version}-${arch}.${ext}");
    expect(config).toContain("oneClick: false");
    expect(config).toContain("perMachine: false");
  });
});
