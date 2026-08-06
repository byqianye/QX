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
      const source = Object.keys(playback.headers).length > 0
        ? await this.createProxySource(playback)
        : playback;
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
    this.proxySession = await this.proxy.createSession(playback);
    return { parse: 0, url: this.proxySession.url, headers: {} };
  }

  private async releaseCurrent(): Promise<void> {
    this.playerController.stop();
    this.source = null;
    this.playback = null;
    const proxySession = this.proxySession;
    this.proxySession = undefined;
    if (proxySession) await proxySession.close();
  }
}
