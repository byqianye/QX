import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  EpgRepository,
  LiveRepository,
  SmartChannelRepository,
} from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";
import { EpgMatchingService } from "../src/epg/epg-matching-service.js";
import { EpgService } from "../src/epg/epg-service.js";
import {
  DesktopSpiderUiController,
  DesktopSpiderUiServer,
  type DesktopSpiderSessionPort,
  type DesktopSpiderView,
} from "../src/desktop/spider-ui.js";
import { EMPTY_EPG_UI_STATE } from "../src/epg/epg-types.js";
import { LiveSourceService } from "../src/live/live-service.js";
import { SmartChannelError, SmartChannelService } from "../src/live/smart-channels.js";
import type { LiveChannelWithStreams } from "../src/live/live-types.js";
import type { SpiderResponse } from "../src/spider/rpc.js";

describe("Smart Channels", () => {
  const directories: string[] = [];
  const servers: DesktopSpiderUiServer[] = [];
  let layer: SqliteDataLayer | undefined;

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.close();
    layer?.close();
    layer = undefined;
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back Smart Channel creation when a member insert fails", async () => {
    const context = await createContext();
    const source = await importLive(context.live, "Source", "https://source.example/playlist.m3u");
    const liveChannel = context.liveRepository.getChannels(source.id)[0]!;
    const member = {
      id: "smart-member-transaction",
      smartChannelId: "smart-transaction",
      liveChannelId: liveChannel.id,
      priority: 0,
      enabled: true,
    };

    expect(() => context.repository.create({
      id: "smart-transaction",
      name: "Transaction test",
      logo: null,
      group: null,
      sortOrder: 0,
      preferredMemberId: null,
      epgSourceId: null,
      epgChannelId: null,
      createdAt: NOW,
      updatedAt: NOW,
    }, [member, { ...member }])).toThrow();
    expect(context.repository.get("smart-transaction")).toBeNull();
    expect(context.repository.listMembers("smart-transaction")).toHaveLength(0);
  });

  it("creates members, prefers health and manual selection, and survives source deletion", async () => {
    const context = await createContext();
    const sourceA = await importLive(context.live, "Source A", "https://source-a.example/playlist.m3u");
    const sourceB = await importLive(context.live, "Source B", "https://source-b.example/playlist.m3u");
    const channelA = context.liveRepository.getChannels(sourceA.id)[0]!;
    const channelB = context.liveRepository.getChannels(sourceB.id)[0]!;

    const smart = context.service.create({ name: "News Smart", group: "Favorites", memberIds: [channelA.id, channelB.id] });
    expect(context.repository.listMembers(smart.id)).toHaveLength(2);

    context.service.setHealthScore(channelA.id, 25);
    context.service.setHealthScore(channelB.id, 95);
    expect(context.service.select(smart.id).member.liveChannelId).toBe(channelB.id);

    const memberA = context.repository.listMembers(smart.id).find((member) => member.liveChannelId === channelA.id)!;
    context.service.setPreferredMember(smart.id, memberA.id);
    expect(context.service.select(smart.id).member.liveChannelId).toBe(channelA.id);

    context.service.updateMember(smart.id, memberA.id, { enabled: false, priority: 7 });
    expect(context.service.select(smart.id).member.liveChannelId).toBe(channelB.id);
    context.service.removeMember(smart.id, memberA.id);
    expect(context.repository.listMembers(smart.id)).toHaveLength(1);

    const second = context.service.create({ name: "Survivor", memberIds: [channelA.id, channelB.id] });
    context.liveRepository.deleteSource(sourceB.id);
    expect(context.repository.get(second.id)).not.toBeNull();
    expect(context.repository.listMembers(second.id)).toHaveLength(1);
    expect(context.repository.listMembers(second.id)[0]?.liveChannelId).toBe(channelA.id);

    const state = context.service.uiState(context.live.uiState().catalog, EMPTY_EPG_UI_STATE);
    const survivor = state.smartChannels.find((channel) => channel.id === second.id)!;
    expect(survivor).toMatchObject({ available: true, currentMemberId: expect.any(String) });
    expect(survivor.members[0]).toMatchObject({ available: true, channelName: "News" });
    context.liveRepository.deleteSource(sourceA.id);
    const unavailable = context.service.uiState(context.live.uiState().catalog, EMPTY_EPG_UI_STATE).smartChannels.find((channel) => channel.id === second.id)!;
    expect(unavailable).toMatchObject({ available: false, currentMemberId: null });
    expect(unavailable.members).toHaveLength(0);

    layer!.close();
    layer = SqliteDataLayer.create(join(directories[0]!, "qx-yingshi.db"));
    const reopenedRepository = new SmartChannelRepository(layer);
    expect(reopenedRepository.get(second.id)).toMatchObject({ name: "Survivor" });
    expect(reopenedRepository.listMembers(second.id)).toHaveLength(0);
  });

  it("keeps EPG inheritance explicit and never picks a conflicting mapping at random", async () => {
    const context = await createContext();
    const sourceA = await importLive(context.live, "Source A", "https://source-a.example/playlist.m3u");
    const sourceB = await importLive(context.live, "Source B", "https://source-b.example/playlist.m3u");
    const channelA = context.liveRepository.getChannels(sourceA.id)[0]!;
    const channelB = context.liveRepository.getChannels(sourceB.id)[0]!;
    const epg = new EpgService({ repository: context.epgRepository, now: () => NOW });
    const preview = await epg.previewSource({
      name: "Guide",
      type: "fixture",
      content: `<tv><channel id="news"><display-name>News</display-name></channel><programme channel="news" start="20260807110000 UTC" stop="20260807130000 UTC"><title>Current</title></programme></tv>`,
    });
    const epgSource = await epg.applyPreview(preview.id);
    const epgChannel = context.epgRepository.getChannels(epgSource.id)[0]!;
    const matching = new EpgMatchingService({ liveRepository: context.liveRepository, epgRepository: context.epgRepository, now: () => NOW });
    matching.setMapping(channelA.id, epgSource.id, epgChannel.id);
    matching.setMapping(channelB.id, epgSource.id, epgChannel.id);
    const matched = matching.uiState(context.live.uiState().catalog, epg.uiState());
    const smart = context.service.create({ name: "EPG Smart", memberIds: [channelA.id, channelB.id] });
    context.service.setPreferredMember(smart.id, context.repository.listMembers(smart.id)[0]!.id);
    const inherited = context.service.uiState(matched.catalog, matched.epg).smartChannels[0]!;
    expect(inherited.epg).toMatchObject({ mode: "inherited", channelName: "News", currentProgramme: { title: "Current" } });

    context.service.setEpgMapping(smart.id, epgSource.id, epgChannel.id);
    const explicit = context.service.uiState(matched.catalog, matched.epg).smartChannels[0]!;
    expect(explicit.epg).toMatchObject({ mode: "explicit", channelName: "News" });

    const unmapped = context.service.create({ name: "No EPG", memberIds: [channelA.id, channelB.id] });
    const noMapping = context.service.uiState(matched.catalog, matched.epg).smartChannels.find((channel) => channel.id === unmapped.id)!;
    expect(noMapping.epg.mode).toBe("unmapped");
    expect(noMapping.epg.channelId).toBeNull();
    epg.close();
    matching.close();
  });

  it("exposes manual Smart Channel management through the desktop API", async () => {
    const context = await createContext();
    const sourceA = await importLive(context.live, "Source A", "https://source-a.example/playlist.m3u");
    const sourceB = await importLive(context.live, "Source B", "https://source-b.example/playlist.m3u");
    const channelA = context.liveRepository.getChannels(sourceA.id)[0]!;
    const channelB = context.liveRepository.getChannels(sourceB.id)[0]!;
    const server = new DesktopSpiderUiServer({
      ui: new DesktopSpiderUiController({ session: new SmartUiSession() }),
      siteKey: "fixture",
      ext: "fixture",
      live: context.live,
      smartChannels: context.service,
    });
    servers.push(server);
    await server.start();

    const created = await post(server.url, "/api/live/smart/create", {
      name: "API Smart",
      memberIds: [channelA.id, channelB.id],
    });
    const smart = created.state.live.smartChannels[0];
    expect(smart).toMatchObject({ name: "API Smart", members: expect.any(Array) });
    const member = smart.members[0];
    const renamed = await post(server.url, "/api/live/smart/update", { smartChannelId: smart.id, name: "Renamed Smart", sortOrder: 4 });
    expect(renamed.state.live.smartChannels[0]).toMatchObject({ name: "Renamed Smart", sortOrder: 4 });
    const changed = await post(server.url, "/api/live/smart/member/priority", { smartChannelId: smart.id, memberId: member.id, priority: 9 });
    expect(changed.state.live.smartChannels[0].members.find((item: any) => item.id === member.id).priority).toBe(9);
    const removed = await post(server.url, "/api/live/smart/member/remove", { smartChannelId: smart.id, memberId: member.id });
    expect(removed.state.live.smartChannels[0].members).toHaveLength(1);
    const deleted = await post(server.url, "/api/live/smart/delete", { smartChannelId: smart.id });
    expect(deleted.state.live.smartChannels).toHaveLength(0);
    expect(JSON.stringify(deleted.state.live.smartChannels)).not.toContain("source-a.example");
  });

  async function createContext() {
    const directory = mkdtempSync(join(tmpdir(), "qx-smart-channel-"));
    directories.push(directory);
    layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    const liveRepository = new LiveRepository(layer);
    const epgRepository = new EpgRepository(layer);
    const repository = new SmartChannelRepository(layer);
    const live = new LiveSourceService({ repository: liveRepository, now: () => NOW });
    const service = new SmartChannelService({ repository, liveRepository, epgRepository, now: () => NOW });
    return { live, liveRepository, epgRepository, repository, service };
  }
});

const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);

async function importLive(live: LiveSourceService, name: string, location: string) {
  const preview = await live.previewSource({
    name,
    type: "fixture",
    format: "m3u",
    content: `#EXTM3U\n#EXTINF:-1 tvg-id="news",News\n${location}\n`,
  });
  return live.applyPreview(preview.id);
}

async function post(baseUrl: string, pathname: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json() as any;
  if (!response.ok) throw new Error(`${pathname}: ${JSON.stringify(value)}`);
  return value;
}

class SmartUiSession implements DesktopSpiderSessionPort {
  public readonly view: DesktopSpiderView = {
    source: "fixture:smart",
    api: "csp_SmartFixture",
    status: "ready",
    warning: null,
    error: null,
    sidecarRunning: true,
    playback: { available: false, label: "Unavailable", message: "No playback" },
  };

  public confirmImport(): void {}
  public async open(): Promise<SpiderResponse> { return { id: "smart", ok: true, result: {} }; }
  public async homeContent(): Promise<SpiderResponse> { return { id: "smart", ok: true, result: { list: [] } }; }
  public async categoryContent(): Promise<SpiderResponse> { return { id: "smart", ok: true, result: { list: [] } }; }
  public async searchContent(): Promise<SpiderResponse> { return { id: "smart", ok: true, result: { list: [] } }; }
  public async detailContent(): Promise<SpiderResponse> { return { id: "smart", ok: true, result: { list: [] } }; }
  public async playerContent(): Promise<SpiderResponse> { return { id: "smart", ok: false, error: { code: "PLAYBACK_UNAVAILABLE", message: "No playback" } }; }
  public async destroy(): Promise<void> { this.view.status = "destroyed"; this.view.sidecarRunning = false; }
}
