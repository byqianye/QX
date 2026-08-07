import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EpgRepository, LiveRepository } from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";
import { EpgMatchingService } from "../src/epg/epg-matching-service.js";
import { EpgService } from "../src/epg/epg-service.js";
import { LiveSourceService } from "../src/live/live-service.js";

const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);

describe("EPG matching and programme timeline", () => {
  let directory: string;
  let layer: SqliteDataLayer;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "qx-epg-matching-"));
    layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
  });

  afterEach(() => {
    layer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("matches in strict order, keeps explicit mappings, exposes ambiguity, and windows the timeline", async () => {
    const liveRepository = new LiveRepository(layer);
    const epgRepository = new EpgRepository(layer);
    const liveService = new LiveSourceService({ repository: liveRepository, now: () => NOW });
    const livePreview = await liveService.previewSource({
      name: "Matching live",
      type: "fixture",
      format: "m3u",
      content: [
        "#EXTM3U",
        '#EXTINF:-1 tvg-id="news-id",News HD',
        "https://media.example/news.m3u8",
        "#EXTINF:-1,Ｍｏｖｉｅ　Ｃｈａｎｎｅｌ",
        "https://media.example/movie.m3u8",
        "#EXTINF:-1,Call Sign",
        "https://media.example/call.m3u8",
        "#EXTINF:-1,Sports",
        "https://media.example/sports.m3u8",
        "#EXTINF:-1,Manual",
        "https://media.example/manual.m3u8",
      ].join("\n"),
    });
    const liveSource = await liveService.applyPreview(livePreview.id);
    const liveChannels = liveRepository.getChannels(liveSource.id);

    const epgService = new EpgService({ repository: epgRepository, now: () => NOW });
    const epgPreview = await epgService.previewSource({
      name: "Matching EPG",
      type: "fixture",
      content: `<tv>
        <channel id="news-id"><display-name>News HD</display-name></channel>
        <channel id="movie-id"><display-name>Movie Channel</display-name></channel>
        <channel id="alias-id"><display-name>Alias Target</display-name><display-name>CALL</display-name></channel>
        <channel id="sports-a"><display-name>Sports</display-name></channel>
        <channel id="sports-b"><display-name>Sports</display-name></channel>
        <channel id="other-id"><display-name>Other</display-name></channel>
        <programme channel="news-id" start="20260807110000 UTC" stop="20260807130000 UTC"><title>News Current</title></programme>
        <programme channel="news-id" start="20260807130000 UTC" stop="20260807140000 UTC"><title>News Next</title></programme>
        <programme channel="movie-id" start="20260807100000 UTC" stop="20260807110000 UTC"><title>Movie Earlier</title></programme>
        <programme channel="movie-id" start="20260807130000 UTC" stop="20260807150000 UTC"><title>Movie Future</title></programme>
        <programme channel="alias-id" start="20260807120000 UTC" stop="20260807130000 UTC"><title>Alias Current</title></programme>
        <programme channel="other-id" start="20260807120000 UTC" stop="20260807130000 UTC"><title>Other Current</title></programme>
      </tv>`,
    });
    const epgSource = await epgService.applyPreview(epgPreview.id);
    const matching = new EpgMatchingService({ liveRepository, epgRepository, now: () => NOW });

    const initial = matching.uiState(liveService.uiState().catalog, epgService.uiState());
    const news = initial.catalog.channels.find((channel) => channel.name === "News HD");
    const movie = initial.catalog.channels.find((channel) => channel.name.normalize("NFKC").includes("Movie"));
    const call = initial.catalog.channels.find((channel) => channel.name === "Call Sign");
    const sports = initial.catalog.channels.find((channel) => channel.name === "Sports");
    const manual = initial.catalog.channels.find((channel) => channel.name === "Manual");
    expect(news?.epgStatus).toBe("mapped");
    expect(news?.currentProgramme).toMatchObject({ title: "News Current", progress: 0.5 });
    expect(news?.nextProgramme).toMatchObject({ title: "News Next" });
    expect(initial.epg.mappings.find((mapping) => mapping.liveChannelName === "News HD")?.mapping?.method).toBe("tvg-id");
    expect(movie?.epgStatus).toBe("mapped");
    expect(movie?.currentProgramme).toBeNull();
    expect(movie?.nextProgramme).toMatchObject({ title: "Movie Future" });
    expect(call?.epgStatus).toBe("unmapped");
    expect(sports?.epgStatus).toBe("ambiguous");
    expect(initial.epg.mappings.find((mapping) => mapping.liveChannelName === "Sports")?.candidates).toHaveLength(2);

    expect(manual).toBeDefined();
    matching.setMapping(manual!.id, epgSource.id, epgRepository.getChannels(epgSource.id).find((channel) => channel.externalId === "other-id")!.id);
    matching.setAlias(call!.id, "CALL");
    const withExplicit = matching.uiState(liveService.uiState().catalog, epgService.uiState());
    expect(withExplicit.epg.mappings.find((mapping) => mapping.liveChannelId === manual!.id)?.mapping).toMatchObject({
      method: "explicit",
      userConfirmed: true,
    });
    expect(withExplicit.epg.mappings.find((mapping) => mapping.liveChannelId === call!.id)?.status).toBe("suggested");
    expect(withExplicit.epg.mappings.find((mapping) => mapping.liveChannelId === call!.id)?.candidates[0]?.method).toBe("alias");

    matching.setTimeline(news!.id, NOW - 60 * 60 * 1000, NOW + 3 * 60 * 60 * 1000);
    const timeline = matching.uiState(liveService.uiState().catalog, epgService.uiState());
    const timelineValue = timeline.epg.timeline;
    expect(timelineValue).not.toBeNull();
    expect(timelineValue?.items.map((item) => item.title)).toEqual(["News Current", "News Next"]);
    expect(timelineValue!.toAt - timelineValue!.fromAt).toBe(4 * 60 * 60 * 1000);

    matching.setTimeline(news!.id);
    const preservedTimeline = matching.uiState(liveService.uiState().catalog, epgService.uiState()).epg.timeline;
    expect(preservedTimeline).toMatchObject({
      liveChannelId: news!.id,
      fromAt: NOW - 60 * 60 * 1000,
      toAt: NOW + 3 * 60 * 60 * 1000,
    });
    expect(preservedTimeline?.items.map((item) => item.title)).toEqual(["News Current", "News Next"]);

    expect(matching.confirmHighConfidence(timeline.catalog)).toBe(2);
    expect(epgRepository.listMappings().filter((mapping) => mapping.userConfirmed)).toHaveLength(3);
  });

  it("allows multiple live channels to share one EPG channel and preserves mappings after restart", async () => {
    const liveRepository = new LiveRepository(layer);
    const epgRepository = new EpgRepository(layer);
    const liveService = new LiveSourceService({ repository: liveRepository, now: () => NOW });
    const livePreview = await liveService.previewSource({
      name: "Restart live",
      type: "fixture",
      format: "m3u",
      content: "#EXTM3U\n#EXTINF:-1,One\nhttps://media.example/one.m3u8\n#EXTINF:-1,Two\nhttps://media.example/two.m3u8\n",
    });
    const liveSource = await liveService.applyPreview(livePreview.id);
    const channels = liveRepository.getChannels(liveSource.id);
    const epgService = new EpgService({ repository: epgRepository, now: () => NOW });
    const sharedEpgContent = `<tv><channel id="shared"><display-name>Shared</display-name></channel><programme channel="shared" start="20260807120000 UTC" stop="20260807130000 UTC"><title>Shared Current</title></programme></tv>`;
    const epgPreview = await epgService.previewSource({
      name: "Restart EPG",
      type: "fixture",
      content: sharedEpgContent,
    });
    const epgSource = await epgService.applyPreview(epgPreview.id);
    const shared = epgRepository.getChannels(epgSource.id)[0]!;
    const matching = new EpgMatchingService({ liveRepository, epgRepository, now: () => NOW });
    matching.setMapping(channels[0]!.id, epgSource.id, shared.id);
    matching.setMapping(channels[1]!.id, epgSource.id, shared.id);
    expect(epgRepository.listMappings()).toHaveLength(2);
    const refreshedPreview = await epgService.previewSource({
      name: "Restart EPG",
      type: "fixture",
      content: sharedEpgContent,
      sourceId: epgSource.id,
    });
    await epgService.applyPreview(refreshedPreview.id);
    expect(epgRepository.listMappings()).toHaveLength(2);
    expect(epgRepository.listMappings().every((mapping) => mapping.userConfirmed)).toBe(true);
    matching.close();
    epgService.close();
    layer.close();

    layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    const reopenedLive = new LiveRepository(layer);
    const reopenedEpg = new EpgRepository(layer);
    const reopenedService = new EpgMatchingService({ liveRepository: reopenedLive, epgRepository: reopenedEpg, now: () => NOW });
    const reopenedLiveService = new LiveSourceService({ repository: reopenedLive, now: () => NOW });
    const state = reopenedService.uiState(reopenedLiveService.uiState().catalog, {
      sources: reopenedEpg.listSources().map((source) => ({ ...source, channelCount: 1, programmeCount: 1 })),
      preview: null,
      loading: false,
      error: null,
      retention: { pastRetentionMs: 1, futureRetentionMs: 1 },
      mappings: [],
      timeline: null,
    });
    expect(state.epg.mappings.filter((mapping) => mapping.mapping?.userConfirmed)).toHaveLength(2);
  });
});
