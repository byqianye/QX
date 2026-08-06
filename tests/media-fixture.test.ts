import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMediaFixtureServer,
  type MediaFixtureServer,
} from "../src/electron/media-fixture.js";

describe("local media fixture server", () => {
  let fixture: MediaFixtureServer;

  beforeAll(async () => {
    fixture = createMediaFixtureServer();
    await fixture.start();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("serves a short local MP4 fixture with byte ranges", async () => {
    const response = await fetch(fixture.mp4Url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);

    const range = await fetch(fixture.mp4Url, { headers: { Range: "bytes=0-3" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toMatch(/^bytes 0-3\//);
    expect((await range.arrayBuffer()).byteLength).toBe(4);
  });

  it("serves a local HLS playlist and closes its HTTP server", async () => {
    const response = await fetch(fixture.hlsUrl);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/vnd.apple.mpegurl");
    expect(body).toContain("#EXTM3U");
    expect(body).toContain('#EXT-X-MAP:URI="/media/fixture-init.mp4"');
    expect(body).toContain("/media/fixture-0.m4s");

    const init = await fetch(new URL("/media/fixture-init.mp4", fixture.baseUrl));
    const segment = await fetch(new URL("/media/fixture-0.m4s", fixture.baseUrl));
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toBe("video/mp4");
    expect((await init.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(segment.status).toBe(200);
    expect(segment.headers.get("content-type")).toBe("video/iso.segment");
    expect((await segment.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("serves a local HLS master playlist and its child playlist", async () => {
    const master = await fetch(fixture.hlsMasterUrl);
    const child = await fetch(fixture.hlsChildUrl);

    expect(master.status).toBe(200);
    expect(await master.text()).toContain("#EXT-X-STREAM-INF");
    expect(child.status).toBe(200);
    expect(await child.text()).toContain("#EXT-X-MAP");
  });

  it("returns deterministic playerContent results for MP4, HLS and headered cases", async () => {
    const mp4 = await fetch(`${fixture.playerUrl}?id=direct-mp4`);
    const hls = await fetch(`${fixture.playerUrl}?id=direct-hls`);
    const headered = await fetch(`${fixture.playerUrl}?id=headered`);

    await expect(mp4.json()).resolves.toMatchObject({ parse: 0, url: fixture.mp4Url, header: {} });
    await expect(hls.json()).resolves.toMatchObject({ parse: 0, url: fixture.hlsUrl, header: {} });
    await expect(headered.json()).resolves.toMatchObject({
      parse: 0,
      url: fixture.protectedHlsUrl,
      header: {
        Referer: "https://source.example.invalid/",
        "User-Agent": "G22-fixture",
      },
    });
  });

  it("returns bounded parse and fallback fixture failures", async () => {
    const parseSniff = await fetch(`${fixture.playerUrl}?id=parse-sniff`);
    const fallback = await fetch(`${fixture.playerUrl}?id=fallback-fail`);

    await expect(parseSniff.json()).resolves.toMatchObject({
      parse: 1,
      header: { "X-QX-Parse-Scenario": "sniff" },
    });
    expect(fallback.status).toBe(503);
  });

  it("requires the protected HLS headers and accepts them when injected", async () => {
    const denied = await fetch(fixture.protectedHlsUrl);
    expect(denied.status).toBe(403);

    const allowed = await fetch(fixture.protectedHlsUrl, {
      headers: {
        Referer: "https://source.example.invalid/",
        "User-Agent": "G22-fixture",
      },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("/protected/fixture-0.m4s");
  });

  it("serves isolated-sniffer false candidates and bounded failure scenarios", async () => {
    const page = await fetch(fixture.sniffUrl);
    const pageBody = await page.text();
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toContain("qx-sniffer-fixture=isolated");
    expect(pageBody).toContain("/sniff/poster.jpg");
    expect(pageBody).toContain("/sniff/delayed.m3u8");

    const redirect = await fetch(`${fixture.sniffUrl}?mode=redirect`, { redirect: "manual" });
    expect(redirect.status).toBe(200);
    const redirectBody = await redirect.text();
    expect(redirectBody).toContain("/sniff/redirect");

    const popup = await fetch(`${fixture.sniffUrl}?mode=popup`);
    expect(await popup.text()).toContain("window.open");
    const protocol = await fetch(`${fixture.sniffUrl}?mode=protocol`);
    expect(await protocol.text()).toContain("file:///");
    const infinite = await fetch(`${fixture.sniffUrl}?mode=infinite`);
    expect(await infinite.text()).toContain("setInterval");
  });

  it("serves the local Douban-compatible aggregate fixture", async () => {
    const home = await fetch(fixture.doubanEndpoint);
    const search = await fetch(`${fixture.baseUrl}/subject_search?search_text=fixture&start=0`);
    const detail = await fetch(`${fixture.baseUrl}/api/v2/movie/36246195`);

    await expect(home.json()).resolves.toMatchObject({
      subject_collection_items: [{ id: "36246195" }],
    });
    expect(await search.text()).toContain("window.__DATA__");
    await expect(detail.json()).resolves.toMatchObject({ id: "36246195" });
  });
});
