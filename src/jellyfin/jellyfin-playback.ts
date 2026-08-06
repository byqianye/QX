import {
  EmbeddedPlaybackController,
  type PlaybackSource,
  type PlaybackState,
} from "../desktop/playback.js";
import {
  PlaybackProxyServer,
  type PlaybackProxySession,
} from "../desktop/playback-proxy.js";
import type { JellyfinAdapter, JellyfinPlayback } from "./jellyfin-adapter.js";
import type { SubtitleTrack } from "../subtitles.js";

export interface JellyfinEmbeddedPlaybackState {
  playback: {
    parse: 0;
    url: string;
    directPlay: true;
    itemId: string;
    mediaSourceId: string;
  } | null;
  source: PlaybackSource | null;
  player: PlaybackState;
}

export class JellyfinPlaybackSession {
  private readonly adapter: JellyfinAdapter;
  private readonly playerController = new EmbeddedPlaybackController();
  private readonly proxy: PlaybackProxyServer;
  private proxySession: PlaybackProxySession | undefined;
  private subtitleProxySessions: PlaybackProxySession[] = [];
  private playback: JellyfinPlayback | null = null;
  private source: PlaybackSource | null = null;

  public constructor(adapter: JellyfinAdapter) {
    this.adapter = adapter;
    this.proxy = new PlaybackProxyServer({
      allowedOrigins: [adapter.origin],
      allowedUpstreamHeaders: ["x-emby-token"],
    });
  }

  public get state(): JellyfinEmbeddedPlaybackState {
    return {
      playback: this.playback ? {
        parse: 0,
        url: this.playback.url,
        directPlay: this.playback.directPlay,
        itemId: this.playback.itemId,
        mediaSourceId: this.playback.mediaSourceId,
      } : null,
      source: this.source ? {
        ...this.source,
        headers: { ...this.source.headers },
      } : null,
      player: this.playerController.state,
    };
  }

  public async load(itemId: string): Promise<JellyfinEmbeddedPlaybackState> {
    await this.releaseCurrent();
    const playback = await this.adapter.getPlayback(itemId);
    try {
      const source = await this.createProxySource(playback);
      this.playback = playback;
      this.source = source;
      this.playerController.load(source);
      return this.state;
    } catch (error) {
      await this.releaseCurrent();
      throw error;
    }
  }

  public async close(): Promise<void> {
    await this.releaseCurrent();
    await this.proxy.close();
  }

  private async createProxySource(playback: JellyfinPlayback): Promise<PlaybackSource> {
    const media = Object.keys(playback.headers).length > 0
      ? await this.proxy.createSession(playback)
      : null;
    this.proxySession = media ?? undefined;
    const subtitles: SubtitleTrack[] = [];
    for (const track of playback.subtitles ?? []) {
      if (!track.url) continue;
      const proxy = await this.proxy.createSession({
        parse: 0,
        url: track.url,
        headers: { ...(track.headers ?? {}) },
        sourceId: "jellyfin",
        playbackSessionId: playback.itemId,
      });
      this.subtitleProxySessions.push(proxy);
      const { headers: _headers, ...safeTrack } = track;
      subtitles.push({ ...safeTrack, url: proxy.url, source: "local-proxy" });
    }
    return {
      parse: 0,
      url: media?.url ?? playback.url,
      headers: {},
      ...(subtitles.length > 0 ? { subtitles } : {}),
    };
  }

  private async releaseCurrent(): Promise<void> {
    this.playerController.stop();
    this.source = null;
    this.playback = null;
    const proxySession = this.proxySession;
    this.proxySession = undefined;
    if (proxySession) await proxySession.close();
    const subtitleSessions = this.subtitleProxySessions.splice(0);
    for (const session of subtitleSessions) await session.close();
  }
}
