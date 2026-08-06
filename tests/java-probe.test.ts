import { describe, expect, it } from "vitest";

import {
  identifyJarArtifact,
  resolveCspTargetClass,
  selectCspSite,
} from "../src/spikes/java-probe.js";

describe("csp_Douban JVM feasibility boundary", () => {
  it("selects the concrete csp_Douban site from a TVBox config", () => {
    const site = selectCspSite({
      sites: [
        { key: "other", api: "csp_Other" },
        { key: "douban", name: "豆瓣", api: "csp_Douban" },
      ],
    });

    expect(site).toMatchObject({ key: "douban", api: "csp_Douban" });
    expect(resolveCspTargetClass(site.api)).toBe("com.github.catvod.spider.Douban");
  });

  it("distinguishes Android DEX jars from JVM class jars", () => {
    const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

    expect(identifyJarArtifact(Buffer.concat([zipMagic, Buffer.from("/classes.dex")]))).toBe("android-dex-jar");
    expect(identifyJarArtifact(Buffer.concat([zipMagic, Buffer.from("/com/example/Spider.class")]))).toBe("jvm-jar");
    expect(identifyJarArtifact(Buffer.from("not-a-jar"))).toBe("unknown");
  });
});
