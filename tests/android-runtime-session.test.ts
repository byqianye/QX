import { describe, expect, it } from "vitest";

import { inspectImport, ImportTrustStore } from "../src/config/trust.js";
import { DesktopSpiderSession } from "../src/desktop/spider-session.js";
import { runtimeCapabilities, type SpiderRuntime } from "../src/spider/runtime-types.js";
import type { PlayerResult } from "../src/source/media-source.js";

describe("Android runtime session routing", () => {
  it("routes an unknown csp_* site through RuntimeManager when supplied", async () => {
    const source = "inline:android-runtime-session";
    const config = {
      sites: [{ key: "jianpian", type: 3, api: "csp_Jianpian", ext: "fixture" }],
    };
    const trustStore = new ImportTrustStore();
    trustStore.trustAssessment(inspectImport(source, config, trustStore));
    const runtime = fixtureRuntime();
    const session = new DesktopSpiderSession({
      source,
      config,
      trustStore,
      createClient: () => { throw new Error("Android runtime should not use the legacy client"); },
      createRuntime: async () => runtime,
    });

    await expect(session.open("jianpian", "fixture")).resolves.toMatchObject({ ok: true });
    expect(session.view.capabilities).toMatchObject({ engine: "android-dex", search: true, detail: true, playback: true });
    await expect(session.searchContent("庆余年")).resolves.toMatchObject({
      ok: true,
      result: { list: [{ vod_id: "fixture-1" }] },
    });
    await expect(session.playerContent("default", "episode-1")).resolves.toMatchObject({
      ok: true,
      result: { parse: 0, url: "https://media.example.invalid/episode-1.m3u8" },
    });
    expect(session.view.playback).toMatchObject({
      available: true,
      sourceKey: "jianpian",
      sourceName: "jianpian",
      episodeId: "episode-1",
      jx: 0,
    });
    await session.destroy();
  });

  it("normalizes JSON-encoded player headers on the Desktop UI playerContent path", async () => {
    const source = "inline:android-runtime-json-header";
    const config = {
      sites: [{ key: "jianpian", type: 3, api: "csp_Jianpian", ext: "fixture" }],
    };
    const trustStore = new ImportTrustStore();
    trustStore.trustAssessment(inspectImport(source, config, trustStore));
    const runtime = fixtureRuntime();
    const rawPlayerResult = {
      parse: 0,
      jx: 0,
      url: "https://media.example.invalid/json-header.m3u8",
      header: JSON.stringify({
        Referer: "https://source.example.invalid/",
        "User-Agent": "QX-test",
        Origin: "https://source.example.invalid",
        Cookie: "sid=redacted",
      }),
    };
    runtime.player = async (): Promise<PlayerResult> => rawPlayerResult as unknown as PlayerResult;
    const session = new DesktopSpiderSession({
      source,
      config,
      trustStore,
      createClient: () => { throw new Error("Android runtime should not use the legacy client"); },
      createRuntime: async () => runtime,
    });

    await session.open("jianpian", "fixture");
    await expect(session.playerContent("default", "episode-json-header")).resolves.toMatchObject({ ok: true });
    expect(session.view.playback).toMatchObject({
      headers: {
        Referer: "https://source.example.invalid/",
        "User-Agent": "QX-test",
        Origin: "https://source.example.invalid",
        Cookie: "sid=redacted",
      },
    });
    await session.destroy();
  });
});

function fixtureRuntime(): SpiderRuntime {
  const capabilities = runtimeCapabilities("android-dex", { search: true, detail: true, player: true });
  return {
    kind: "android-dex",
    capabilities,
    supports: async () => ({
      runtime: "android-dex",
      supported: true,
      reason: "fixture",
      capabilities,
    }),
    init: async () => undefined,
    home: async () => ({ items: [], categories: [], raw: { list: [] } }),
    homeVideo: async () => ({ items: [], page: 1, raw: { list: [] } }),
    category: async () => ({ items: [], page: 1, raw: { list: [] } }),
    search: async () => ({
      items: [{ id: "fixture-1", name: "Fixture", raw: { vod_id: "fixture-1", vod_name: "Fixture" } }],
      page: 1,
      raw: { list: [{ vod_id: "fixture-1", vod_name: "Fixture" }] },
    }),
    detail: async () => [],
    player: async (): Promise<PlayerResult> => ({
      parse: 0,
      jx: 0,
      url: "https://media.example.invalid/episode-1.m3u8",
      headers: { Referer: "https://source.example.invalid/" },
    }),
    destroy: async () => undefined,
  };
}
