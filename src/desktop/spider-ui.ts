import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve as resolvePath } from "node:path";

import type {
  DesktopSpiderPlaybackState,
  DesktopSpiderSessionStatus,
  DesktopSpiderView,
} from "./spider-session.js";
import {
  renderDesktopSpiderImportUi,
  type DesktopSpiderImportController,
} from "./spider-import.js";
import { renderEmbeddedPlayer } from "./embedded-player-ui.js";
import {
  EmbeddedPlaybackController,
  type PlaybackMediaSync,
  type PlaybackStatus,
  type PlaybackState,
} from "./playback.js";
import {
  PlaybackProxyServer,
  type PlaybackProxySession,
} from "./playback-proxy.js";
import {
  parseVodPlayback,
  type PlaybackCatalog,
  type PlaybackSelection,
} from "./vod-playback.js";
import {
  type DesktopStatePatch,
  type DesktopStateStorePort,
  type PageStatePatch,
} from "./state-persistence.js";
import type { SpiderResponse } from "../spider/rpc.js";

const require = createRequire(import.meta.url);

export type {
  DesktopSpiderPlaybackState,
  DesktopSpiderSessionStatus,
  DesktopSpiderView,
} from "./spider-session.js";

export interface DesktopSpiderSessionPort {
  readonly view: DesktopSpiderView;
  confirmImport(): void;
  open(siteKey: string, ext: string): Promise<SpiderResponse>;
  homeContent(filter?: boolean, timeoutMs?: number): Promise<SpiderResponse>;
  categoryContent(
    typeId: string,
    page: number,
    filter?: boolean,
    extend?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<SpiderResponse>;
  searchContent(
    key: string,
    quick?: boolean,
    page?: number,
    timeoutMs?: number,
  ): Promise<SpiderResponse>;
  detailContent(ids: string[], timeoutMs?: number): Promise<SpiderResponse>;
  playerContent(
    flag: string,
    id: string,
    vipFlags?: string[],
    timeoutMs?: number,
  ): Promise<SpiderResponse>;
  destroy(): Promise<void>;
}

export type DesktopSpiderUiPage = "import" | "home" | "category" | "search" | "detail" | "closed";

export type PlayerHostMode = "embedded" | "detached";

export interface DesktopPlaybackSession {
  id: string;
  host: PlayerHostMode;
  lineIndex: number | null;
  episodeIndex: number | null;
  lineName: string | null;
  episodeName: string | null;
  media: {
    detailId: string | null;
    title: string | null;
    url: string;
  };
}

export type PlayerMediaSync = PlaybackMediaSync;

export interface DesktopSpiderUiState {
  page: DesktopSpiderUiPage;
  source: string;
  api: string | null;
  status: DesktopSpiderSessionStatus;
  loading: boolean;
  warning: string | null;
  error: { code: string; message: string } | null;
  sidecarRunning: boolean;
  playback: DesktopSpiderPlaybackState;
  player: PlaybackState;
  canPlay: boolean;
  items: readonly Record<string, unknown>[];
  detail: Record<string, unknown> | null;
  playbackCatalog: PlaybackCatalog | null;
  playbackSelection: PlaybackSelection | null;
  playerHost: PlayerHostMode;
  playbackSession: DesktopPlaybackSession | null;
}

export interface DesktopSpiderUiOptions {
  session: DesktopSpiderSessionPort;
  createSession?: () => DesktopSpiderSessionPort;
  playbackProxyOrigins?: readonly string[];
}

export class DesktopSpiderUiController {
  private session: DesktopSpiderSessionPort;
  private readonly createSession: (() => DesktopSpiderSessionPort) | undefined;
  private page: Exclude<DesktopSpiderUiPage, "closed"> = "import";
  private activeOperation: string | null = null;
  private localStatus: DesktopSpiderSessionStatus | null = null;
  private localError: { code: string; message: string } | null = null;
  private items: Record<string, unknown>[] = [];
  private detailItem: Record<string, unknown> | null = null;
  private playbackCatalog: PlaybackCatalog | null = null;
  private playbackSelection: PlaybackSelection | null = null;
  private playerHost: PlayerHostMode = "embedded";
  private playbackSession: DesktopPlaybackSession | null = null;
  private readonly playerController = new EmbeddedPlaybackController();
  private readonly playbackProxy: PlaybackProxyServer;
  private proxySession: PlaybackProxySession | undefined;

  public constructor(options: DesktopSpiderUiOptions) {
    this.session = options.session;
    this.createSession = options.createSession;
    this.playbackProxy = new PlaybackProxyServer(
      options.playbackProxyOrigins
        ? { allowedOrigins: options.playbackProxyOrigins }
        : {},
    );
  }

  public get state(): DesktopSpiderUiState {
    const view = this.session.view;
    const status = this.localStatus ?? view.status;
    return {
      page: status === "destroyed" ? "closed" : this.page,
      source: view.source,
      api: view.api,
      status,
      loading: this.activeOperation !== null || status === "loading",
      warning: view.warning,
      error: this.localError ?? view.error,
      sidecarRunning: view.sidecarRunning,
      playback: publicPlaybackState(view.playback),
      player: this.playerController.state,
      canPlay: view.playback.available,
      items: this.items.map((item) => ({ ...item })),
      detail: this.detailItem ? { ...this.detailItem } : null,
      playbackCatalog: clonePlaybackCatalog(this.playbackCatalog),
      playbackSelection: this.playbackSelection ? { ...this.playbackSelection } : null,
      playerHost: this.playerHost,
      playbackSession: clonePlaybackSession(this.playbackSession),
    };
  }

  public confirmImport(): DesktopSpiderUiState {
    this.localError = null;
    try {
      this.session.confirmImport();
      this.localStatus = null;
    } catch (error) {
      void this.setError(error);
    }
    return this.state;
  }

  public open(siteKey: string, ext: string): Promise<DesktopSpiderUiState> {
    return this.run("open", () => this.session.open(siteKey, ext), () => {
      this.page = "home";
      this.items = [];
      this.detailItem = null;
      this.clearPlaybackCatalog();
    });
  }

  public home(filter = false, timeoutMs?: number): Promise<DesktopSpiderUiState> {
    return this.run(
      "home",
      () => this.session.homeContent(filter, timeoutMs),
      (response) => {
        this.page = "home";
        this.items = listFrom(response);
        this.detailItem = null;
      },
    );
  }

  public category(
    typeId: string,
    page: number,
    filter = false,
    extend: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<DesktopSpiderUiState> {
    return this.run(
      "category",
      () => this.session.categoryContent(typeId, page, filter, extend, timeoutMs),
      (response) => {
        this.page = "category";
        this.items = listFrom(response);
        this.detailItem = null;
      },
    );
  }

  public search(
    key: string,
    quick = false,
    page = 1,
    timeoutMs?: number,
  ): Promise<DesktopSpiderUiState> {
    return this.run(
      "search",
      () => this.session.searchContent(key, quick, page, timeoutMs),
      (response) => {
        this.page = "search";
        this.items = listFrom(response);
        this.detailItem = null;
      },
    );
  }

  public detail(vodId: string, timeoutMs?: number): Promise<DesktopSpiderUiState> {
    return this.run(
      "detail",
      () => this.session.detailContent([vodId], timeoutMs),
      (response) => {
        this.page = "detail";
        this.detailItem = listFrom(response)[0] ?? null;
        this.playbackCatalog = this.detailItem ? parseVodPlayback(this.detailItem) : null;
        this.playbackSelection = null;
      },
    );
  }

  public player(
    flag: string,
    id: string,
    vipFlags: string[] = [],
    timeoutMs?: number,
  ): Promise<DesktopSpiderUiState> {
    return this.playPlayer(flag, id, vipFlags, timeoutMs);
  }

  public playEpisode(
    lineIndex: number,
    episodeIndex: number,
    vipFlags: string[] = [],
    timeoutMs?: number,
  ): Promise<DesktopSpiderUiState> {
    const line = this.playbackCatalog?.lines[lineIndex];
    const episode = line?.episodes[episodeIndex];
    if (!line || !episode || !Number.isInteger(lineIndex) || !Number.isInteger(episodeIndex)) {
      this.localStatus = "error";
      this.localError = {
        code: "PLAYBACK_FORMAT_INVALID",
        message: "播放线路或选集不存在。",
      };
      return Promise.resolve(this.state);
    }
    this.playbackSelection = { lineIndex, episodeIndex };
    return this.playPlayer(line.name, episode.id, vipFlags, timeoutMs, {
      lineIndex,
      episodeIndex,
      lineName: line.name,
      episodeName: episode.name,
    });
  }

  public detachPlayer(): DesktopSpiderUiState {
    if (!this.playbackSession || !this.playerController.state.source) {
      this.localError = {
        code: "PLAYBACK_NOT_LOADED",
        message: "当前没有可拆分的播放会话。",
      };
      return this.state;
    }
    this.playerHost = "detached";
    this.playbackSession.host = "detached";
    return this.state;
  }

  public attachPlayer(): DesktopSpiderUiState {
    this.playerHost = "embedded";
    if (this.playbackSession) this.playbackSession.host = "embedded";
    return this.state;
  }

  public syncPlayerState(patch: PlayerMediaSync): DesktopSpiderUiState {
    this.playerController.syncMedia(patch);
    if (patch.error) this.localError = { ...patch.error };
    return this.state;
  }

  public async stopPlayer(): Promise<DesktopSpiderUiState> {
    this.playerController.stop();
    await this.releasePlaybackProxy();
    this.playerHost = "embedded";
    this.playbackSession = null;
    return this.state;
  }

  private playPlayer(
    flag: string,
    id: string,
    vipFlags: string[] = [],
    timeoutMs?: number,
    metadata?: Pick<DesktopPlaybackSession, "lineIndex" | "episodeIndex" | "lineName" | "episodeName">,
  ): Promise<DesktopSpiderUiState> {
    this.playerController.stop();
    this.playbackSession = null;
    this.playerHost = "embedded";
    return this.run(
      "player",
      () => this.session.playerContent(flag, id, vipFlags, timeoutMs),
      async () => {
        this.page = "detail";
        const playback = this.session.view.playback;
        if (playback.available) {
          const source = await this.preparePlayback(playback);
          this.playerController.load({
            parse: source.parse,
            url: source.url,
            headers: source.headers,
          });
          const sourceState = this.playerController.state.source;
          if (!sourceState) throw new Error("Playback source was not loaded");
          this.playbackSession = {
            id: randomUUID(),
            host: "embedded",
            lineIndex: metadata?.lineIndex ?? null,
            episodeIndex: metadata?.episodeIndex ?? null,
            lineName: metadata?.lineName ?? null,
            episodeName: metadata?.episodeName ?? null,
            media: {
              detailId: optionalString(this.detailItem?.vod_id),
              title: optionalString(this.detailItem?.vod_name),
              url: sourceState.url,
            },
          };
        }
      },
    );
  }

  public async switchSource(): Promise<DesktopSpiderUiState> {
    await this.session.destroy();
    this.playerController.stop();
    await this.releasePlaybackProxy();
    this.clearPlaybackSession();
    const nextSession = this.createSession?.();
    if (!nextSession) {
      this.localStatus = "destroyed";
      this.localError = null;
      return this.state;
    }

    this.session = nextSession;
    this.page = "import";
    this.activeOperation = null;
    this.localStatus = null;
    this.localError = null;
    this.items = [];
    this.detailItem = null;
    this.clearPlaybackCatalog();
    return this.state;
  }

  public async close(): Promise<DesktopSpiderUiState> {
    this.activeOperation = null;
    try {
      await this.session.destroy();
      this.playerController.stop();
      await this.releasePlaybackProxy();
      this.clearPlaybackSession();
      this.localStatus = "destroyed";
      this.localError = null;
    } catch (error) {
      await this.setError(error);
    }
    return this.state;
  }

  public async releaseResources(): Promise<void> {
    this.playerController.stop();
    await this.releasePlaybackProxy();
    this.clearPlaybackSession();
  }

  private async run(
    operation: string,
    request: () => Promise<SpiderResponse>,
    onSuccess: (response: SpiderResponse) => void | Promise<void>,
  ): Promise<DesktopSpiderUiState> {
    this.activeOperation = operation;
    this.localStatus = "loading";
    this.localError = null;
    try {
      const response = await request();
      if (response.ok) {
        await onSuccess(response);
        this.localStatus = null;
      } else {
        this.localStatus = "error";
        const error = response.error ?? {
          code: "SPIDER_RPC_ERROR",
          message: "Desktop Spider returned an unsuccessful response",
        };
        this.localError = error;
        if (operation === "player") {
          await this.releasePlaybackProxy();
          this.clearPlaybackSession();
          this.playerController.markError(error.code, error.message);
        }
      }
    } catch (error) {
      await this.setError(error, operation);
    } finally {
      this.activeOperation = null;
    }
    return this.state;
  }

  private async setError(error: unknown, operation?: string): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error
      && (error.name === "JvmSidecarTimeoutError" || /timeout/i.test(message));
    const sessionError = this.session.view.error;
    const thrownCode = isRecord(error) && typeof error.code === "string" ? error.code : null;
    const code = sessionError?.code ?? thrownCode ?? (isTimeout ? "SPIDER_TIMEOUT" : "SPIDER_RUNTIME_ERROR");
    const displayMessage = sessionError?.message ?? message;
    this.localStatus = "error";
    this.localError = {
      code,
      message: displayMessage,
    };
    if (operation === "player") {
      await this.releasePlaybackProxy();
      this.clearPlaybackSession();
      this.playerController.markError(code, displayMessage);
    }
  }

  private async preparePlayback(
    playback: Extract<DesktopSpiderPlaybackState, { available: true }>,
  ): Promise<{ parse: number; url: string; headers: Record<string, string> }> {
    await this.releasePlaybackProxy();
    if (Object.keys(playback.headers).length === 0) {
      return { parse: playback.parse, url: playback.url, headers: {} };
    }
    this.proxySession = await this.playbackProxy.createSession({
      parse: playback.parse,
      url: playback.url,
      headers: playback.headers,
    });
    return { parse: 0, url: this.proxySession.url, headers: {} };
  }

  private async releasePlaybackProxy(): Promise<void> {
    const session = this.proxySession;
    this.proxySession = undefined;
    if (session) await session.close();
    await this.playbackProxy.close();
  }

  private clearPlaybackCatalog(): void {
    this.playbackCatalog = null;
    this.playbackSelection = null;
  }

  private clearPlaybackSession(): void {
    this.playerHost = "embedded";
    this.playbackSession = null;
  }
}

export interface DesktopSpiderUiServerOptions {
  ui?: DesktopSpiderUiController;
  importer?: DesktopSpiderImportController;
  stateStore?: DesktopStateStorePort;
  onPlayerOpen?: () => void | Promise<void>;
  onPlayerAttach?: () => void | Promise<void>;
  onPlayerStop?: () => void | Promise<void>;
  rendererDirectory?: string;
  siteKey?: string;
  ext?: string;
  host?: string;
  port?: number;
  playbackProxyOrigins?: readonly string[];
}

export class DesktopSpiderUiServer {
  private readonly directUi: DesktopSpiderUiController | undefined;
  private readonly importer: DesktopSpiderImportController | undefined;
  private readonly stateStore: DesktopStateStorePort | undefined;
  private readonly onPlayerOpen: (() => void | Promise<void>) | undefined;
  private readonly onPlayerAttach: (() => void | Promise<void>) | undefined;
  private readonly onPlayerStop: (() => void | Promise<void>) | undefined;
  private readonly rendererDirectory: string | undefined;
  private readonly siteKey: string | undefined;
  private readonly ext: string | undefined;
  private readonly host: string;
  private readonly port: number;
  private readonly playbackProxyOrigins: readonly string[] | undefined;
  private server: Server | undefined;
  private boundUrl: string | undefined;
  private boundSession: DesktopSpiderSessionPort | undefined;
  private importedUi: DesktopSpiderUiController | undefined;

  public constructor(options: DesktopSpiderUiServerOptions) {
    if ((options.ui === undefined) === (options.importer === undefined)) {
      throw new Error("Desktop Spider UI server needs exactly one of ui or importer");
    }
    if (options.importer === undefined && (options.siteKey === undefined || options.ext === undefined)) {
      throw new Error("Direct Desktop Spider UI server needs siteKey and ext");
    }
    this.directUi = options.ui;
    this.importer = options.importer;
    this.stateStore = options.stateStore;
    this.onPlayerOpen = options.onPlayerOpen;
    this.onPlayerAttach = options.onPlayerAttach;
    this.onPlayerStop = options.onPlayerStop;
    this.rendererDirectory = options.rendererDirectory
      ? resolvePath(options.rendererDirectory)
      : undefined;
    this.siteKey = options.siteKey;
    this.ext = options.ext;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.playbackProxyOrigins = options.playbackProxyOrigins;
  }

  public get url(): string {
    if (!this.boundUrl) throw new Error("Desktop Spider UI server is not running");
    return this.boundUrl;
  }

  public attachPlayerHost(): DesktopSpiderUiState | null {
    return this.activeUi()?.attachPlayer() ?? null;
  }

  public async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, this.host, () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    this.boundUrl = `http://${this.host}:${address.port}/`;
  }

  public async close(): Promise<void> {
    if (this.importer) {
      await this.importedUi?.releaseResources();
      await this.importer.close();
    } else {
      await this.directUi?.close();
    }
    const server = this.server;
    this.server = undefined;
    this.boundUrl = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", this.url);
      if (request.method === "GET"
        && this.rendererDirectory
        && !url.pathname.startsWith("/api/")) {
        if (this.writeRendererAsset(response, url.pathname)) return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        const ui = this.activeUi();
        if (this.importer && (this.importer.state.status !== "ready" || !ui)) {
          writeHtml(response, renderDesktopSpiderImportUi(this.importer.state));
        } else if (ui) {
          writeHtml(response, renderDesktopSpiderUi(ui.state));
        } else {
          writeJson(response, { error: "Import UI is not ready" }, 409);
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/assets/hls.min.js") {
        this.writeHlsAsset(response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        this.writeCurrentState(response);
        return;
      }
      if (request.method !== "POST") {
        writeJson(response, { error: "Not found" }, 404);
        return;
      }

      const body = await readJson(request);
      if (this.importer && url.pathname.startsWith("/api/import/")) {
        switch (url.pathname) {
          case "/api/import/load":
            await this.importer.import(stringValue(body.input, ""));
            this.persistImportedSite(this.importer.selectedSiteKey);
            break;
          case "/api/import/select":
            this.importer.selectSite(stringValue(body.siteKey, ""));
            this.persistImportedSite(this.importer.selectedSiteKey);
            break;
          case "/api/import/confirm":
            this.importer.confirm();
            break;
          case "/api/import/cancel":
            await this.importer.cancel();
            break;
          default:
            writeJson(response, { error: "Not found" }, 404);
            return;
        }
        this.writeCurrentState(response);
        return;
      }

      if (url.pathname === "/api/view-state") {
        this.stateStore?.patch(statePatchFromRequest(body));
        this.writeCurrentState(response);
        return;
      }

      const ui = this.activeUi();
      if (!ui) throw new Error("Import confirmation is required before Spider actions");
      switch (url.pathname) {
        case "/api/import/confirm":
          ui.confirmImport();
          break;
        case "/api/open":
          if (this.importer) {
            const siteKey = this.importer.selectedSiteKey;
            if (!siteKey) throw new Error("No supported JVM-native Spider site is selected");
            await ui.open(siteKey, this.importer.selectedExt);
          } else {
            await ui.open(this.siteKey as string, this.ext as string);
          }
          this.persistPage({
            siteKey: this.importer?.selectedSiteKey ?? this.siteKey ?? null,
          });
          break;
        case "/api/home":
          await ui.home(Boolean(body.filter));
          this.persistPage({ navigation: "home", scrollTop: 0 });
          break;
        case "/api/category":
          {
            const typeId = stringValue(body.typeId, "hot_gaia");
            const page = numberValue(body.page, 1);
            await ui.category(
              typeId,
              page,
              Boolean(body.filter),
              recordOfStrings(body.extend),
            );
            this.persistPage({
              navigation: "category",
              category: { typeId, page },
              scrollTop: 0,
            });
          }
          break;
        case "/api/search":
          {
            const key = stringValue(body.key, "");
            const page = numberValue(body.page, 1);
            await ui.search(
              key,
              Boolean(body.quick),
              page,
            );
            this.persistPage({
              navigation: "search",
              search: { key, page },
              scrollTop: 0,
            });
          }
          break;
        case "/api/detail":
          {
            const vodId = stringValue(body.vodId, "");
            await ui.detail(vodId);
            this.persistPage({ navigation: "detail", recentDetailId: vodId });
          }
          break;
        case "/api/player/detach":
          ui.detachPlayer();
          break;
        case "/api/player/open":
          if (ui.state.playerHost === "detached") await this.onPlayerOpen?.();
          break;
        case "/api/player/attach":
          ui.attachPlayer();
          await this.onPlayerAttach?.();
          break;
        case "/api/player/stop":
          await ui.stopPlayer();
          await this.onPlayerStop?.();
          break;
        case "/api/player/sync":
          ui.syncPlayerState(playerMediaSyncFromRequest(body));
          break;
        case "/api/player":
          if (Object.prototype.hasOwnProperty.call(body, "lineIndex")
            || Object.prototype.hasOwnProperty.call(body, "episodeIndex")) {
            await ui.playEpisode(
              indexValue(body.lineIndex),
              indexValue(body.episodeIndex),
              stringList(body.vipFlags),
            );
          } else {
            await ui.player(
              stringValue(body.flag, "default"),
              stringValue(body.id, ""),
              stringList(body.vipFlags),
            );
          }
          break;
        case "/api/switch":
          if (this.importer) {
            await this.importedUi?.releaseResources();
            await this.importer.cancel();
          } else {
            await ui.switchSource();
          }
          break;
        case "/api/close":
          if (this.importer) {
            await this.importedUi?.releaseResources();
            await this.importer.close();
          } else {
            await ui.close();
          }
          break;
        default:
          writeJson(response, { error: "Not found" }, 404);
          return;
      }
      this.writeCurrentState(response);
    } catch (error) {
      const ui = this.activeUi();
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = errorCodeFromMessage(message);
      writeJson(response, {
        error: message,
        ...(errorCode ? { errorCode } : {}),
        import: this.importer?.state ?? null,
        state: ui?.state ?? null,
      }, 400);
    }
  }

  private activeUi(): DesktopSpiderUiController | undefined {
    if (!this.importer) return this.directUi;
    const session = this.importer.session;
    if (session !== this.boundSession) {
      this.boundSession = session;
      this.importedUi = session
        ? new DesktopSpiderUiController({
          session,
          ...(this.playbackProxyOrigins ? { playbackProxyOrigins: this.playbackProxyOrigins } : {}),
        })
        : undefined;
    }
    return this.importedUi;
  }

  private writeCurrentState(response: ServerResponse): void {
    const ui = this.activeUi();
    const persistence = this.stateStore?.rendererState();
    if (this.importer) {
      writeJson(response, {
        import: this.importer.state,
        state: ui?.state ?? null,
        ...(persistence ? { persistence } : {}),
      });
    } else {
      writeJson(response, {
        state: ui?.state ?? null,
        ...(persistence ? { persistence } : {}),
      });
    }
  }

  private persistPage(patch: PageStatePatch): void {
    this.stateStore?.patch({ page: patch });
  }

  private persistImportedSite(siteKey: string | null): void {
    const previousSiteKey = this.stateStore?.state.page.siteKey;
    if (previousSiteKey && previousSiteKey !== siteKey) {
      this.stateStore?.patch({
        page: {
          siteKey,
          navigation: "home",
          category: null,
          search: null,
          scrollTop: 0,
          recentDetailId: null,
        },
      });
      return;
    }
    this.persistPage({ siteKey });
  }

  private writeHlsAsset(response: ServerResponse): void {
    try {
      const assetPath = require.resolve("hls.js/dist/hls.min.js");
      const asset = readFileSync(assetPath);
      response.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "content-length": asset.byteLength,
        "cache-control": "no-store",
      });
      response.end(asset);
    } catch {
      writeJson(response, { error: "Bundled hls.js asset is unavailable" }, 500);
    }
  }

  private writeRendererAsset(response: ServerResponse, pathname: string): boolean {
    const directPath = this.rendererFilePath(pathname);
    const filePath = directPath ?? (pathname.startsWith("/assets/")
      ? null
      : this.rendererFilePath("/"));
    if (!filePath) return false;

    try {
      const asset = readFileSync(filePath);
      response.writeHead(200, {
        "content-type": rendererContentType(filePath),
        "content-security-policy": rendererContentSecurityPolicy(),
        "cache-control": "no-store",
        "content-length": asset.byteLength,
      });
      response.end(asset);
      return true;
    } catch {
      return false;
    }
  }

  private rendererFilePath(pathname: string): string | null {
    if (!this.rendererDirectory) return null;
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    } catch {
      return null;
    }
    const candidate = resolvePath(this.rendererDirectory, `.${relativePath}`);
    const root = this.rendererDirectory.endsWith("\\")
      ? this.rendererDirectory
      : `${this.rendererDirectory}\\`;
    if (candidate !== this.rendererDirectory && !candidate.startsWith(root)) return null;
    return existsSync(candidate) ? candidate : null;
  }
}

function rendererContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function rendererContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' blob: http: https:",
    "connect-src 'self' http: https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function errorCodeFromMessage(message: string): string | null {
  const match = /^([A-Z][A-Z0-9_]*):/.exec(message);
  return match?.[1] ?? null;
}

function publicPlaybackState(playback: DesktopSpiderPlaybackState): DesktopSpiderPlaybackState {
  return playback.available
    ? { ...playback, headers: {} }
    : { ...playback };
}

export function renderDesktopSpiderUi(state: DesktopSpiderUiState): string {
  const spiderLabel = state.api ?? "Spider";
  const statusLabel = {
    confirmation_required: "等待导入确认",
    idle: "待启动",
    initializing: "正在启动",
    loading: "加载中",
    ready: "就绪",
    error: "错误",
    destroyed: "已关闭",
  } satisfies Record<DesktopSpiderSessionStatus, string>;
  const items = state.items.map((item) => {
    const vodId = stringValue(item.vod_id, "");
    return `<article class="vod-card" data-testid="vod-card">
      <h3>${escapeHtml(stringValue(item.vod_name, "未命名"))}</h3>
      <p>${escapeHtml(stringValue(item.vod_remarks, ""))}</p>
      <button data-action="detail" data-vod-id="${escapeHtml(vodId)}">查看详情</button>
    </article>`;
  }).join("\n");
  const warning = state.warning && state.status === "confirmation_required"
    ? `<section class="warning" data-testid="import-warning">
        <strong>首次导入需要确认</strong>
        <p>${escapeHtml(state.warning)}</p>
        <button data-action="confirm-import">确认并信任</button>
      </section>`
    : "";
  const error = state.error
    ? `<section class="error" data-testid="error">
        <strong>${escapeHtml(errorLabel(state.error.code))}</strong>
        <span data-testid="error-code">${escapeHtml(state.error.code)}</span>
        <p>${escapeHtml(state.error.message)}</p>
      </section>`
    : "";
  const start = state.status === "idle" || (state.status === "error" && !state.sidecarRunning)
    ? `<button data-action="open">启动 Spider</button>`
    : "";
  const navigation = state.status !== "confirmation_required" && state.status !== "destroyed"
    ? `<nav aria-label="Spider 导航">
        ${start}
        <button data-action="home">首页</button>
        <button data-action="category" data-type-id="hot_gaia" data-page="1">分类</button>
        <button data-action="switch">切换来源</button>
        <button data-action="close">关闭</button>
      </nav>`
    : "";
  const playButton = state.canPlay && state.playback.available
    ? `<button data-testid="play-button" data-action="play" data-play-parse="${state.playback.available ? state.playback.parse : 0}">播放</button>`
    : `<button data-testid="play-button" disabled>播放</button>`;
  const playbackCatalog = state.playbackCatalog
    ? renderPlaybackCatalog(
      state.playbackCatalog,
      state.playbackSelection,
      state.status === "error" && state.error?.code.startsWith("PLAYBACK_") === true,
    )
    : "";
  const playerMarkup = state.playerHost === "detached"
    ? `<section data-testid="detached-player-panel" class="embedded-player-panel">
        <strong>独立播放窗口</strong>
        <p data-testid="detached-player-status">播放已转移到独立窗口，主窗口不会后台播放。</p>
        <button data-action="player-attach">返回主窗口</button>
        <button data-action="player-stop">停止播放</button>
      </section>`
    : renderEmbeddedPlayer(state.player);
  const detail = state.detail
    ? `<section data-testid="detail-panel" class="detail-panel">
        <h2>${escapeHtml(stringValue(state.detail.vod_name, "详情"))}</h2>
        <p>${escapeHtml(stringValue(state.detail.vod_content, ""))}</p>
        ${playButton}
        <span data-testid="playback-label">${escapeHtml(state.playback.label)}</span>
      </section>`
    : `<section data-testid="playback-panel" class="playback-panel">
        ${playButton}
        <span data-testid="playback-label">${escapeHtml(state.playback.label)}</span>
      </section>`;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>QX 影视 Spider</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, sans-serif; }
      body { margin: 0; background: #f4f6f8; color: #17202a; }
      main { max-width: 960px; margin: 0 auto; padding: 24px; }
      header, section, nav, form { background: #fff; border: 1px solid #dce1e6; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
      nav { display: flex; flex-wrap: wrap; gap: 8px; }
      button { cursor: pointer; padding: 8px 12px; }
      button:disabled { cursor: not-allowed; opacity: .55; }
      .warning { border-color: #e3a008; background: #fff8e1; }
      .error { border-color: #d64545; background: #fff1f1; }
      .loading { color: #946200; }
      .vod-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
      .vod-card { border: 1px solid #dce1e6; border-radius: 8px; padding: 12px; background: #fff; }
      .meta { color: #5b6570; font-size: .9rem; }
      .embedded-player-panel video { display: block; width: 100%; max-height: 520px; background: #101418; }
      .player-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
      .player-controls label { display: inline-flex; gap: 4px; align-items: center; }
      .player-error { color: #b42318; }
    </style>
  </head>
  <body>
    <main data-testid="desktop-spider-ui" data-status="${escapeHtml(state.status)}">
      <header>
        <h1>QX 影视 · ${escapeHtml(spiderLabel)}</h1>
        <p class="meta">来源：${escapeHtml(displaySource(state.source))} · API：${escapeHtml(displaySource(state.api ?? "未选择"))}</p>
        <p data-testid="status" class="${state.loading ? "loading" : ""}">${escapeHtml(statusLabel[state.status])}${state.loading ? " · 加载中" : ""}</p>
      </header>
      ${warning}
      ${error}
      ${navigation}
      <form data-testid="search-form" data-action="search-form">
        <label>搜索 <input name="key" autocomplete="off"></label>
        <button type="submit">搜索</button>
      </form>
      ${detail}
      ${playbackCatalog}
      ${playerMarkup}
      <section class="vod-list" data-testid="vod-list">${items}</section>
    </main>
    <script>
      (() => {
        const send = async (path, body = {}) => {
          const status = document.querySelector('[data-testid="status"]');
          if (status) { status.textContent = '加载中'; status.classList.add('loading'); }
          await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          window.location.reload();
        };
        document.querySelectorAll('[data-action="confirm-import"]').forEach((button) => button.addEventListener('click', () => send('/api/import/confirm')));
        document.querySelectorAll('[data-action="open"]').forEach((button) => button.addEventListener('click', () => send('/api/open')));
        document.querySelectorAll('[data-action="home"]').forEach((button) => button.addEventListener('click', () => send('/api/home')));
        document.querySelectorAll('[data-action="category"]').forEach((button) => button.addEventListener('click', () => send('/api/category', { typeId: button.dataset.typeId, page: Number(button.dataset.page || '1') })));
        document.querySelectorAll('[data-action="detail"]').forEach((button) => button.addEventListener('click', () => send('/api/detail', { vodId: button.dataset.vodId })));
        document.querySelectorAll('[data-action="switch"]').forEach((button) => button.addEventListener('click', () => send('/api/switch')));
        document.querySelectorAll('[data-action="close"]').forEach((button) => button.addEventListener('click', () => send('/api/close')));
        document.querySelectorAll('[data-action="player-attach"]').forEach((button) => button.addEventListener('click', () => send('/api/player/attach')));
        document.querySelectorAll('[data-action="player-stop"]').forEach((button) => button.addEventListener('click', () => send('/api/player/stop')));
        const lineButtons = [...document.querySelectorAll('[data-action="playback-line"]')];
        const linePanels = [...document.querySelectorAll('[data-playback-line]')];
        const activateLine = (lineIndex) => {
          lineButtons.forEach((button) => {
            const active = button.dataset.lineIndex === String(lineIndex);
            button.setAttribute('aria-pressed', String(active));
          });
          linePanels.forEach((panel) => {
            panel.hidden = panel.dataset.playbackLine !== String(lineIndex);
          });
          const activeButton = lineButtons.find((button) => button.dataset.lineIndex === String(lineIndex));
          const currentLine = document.querySelector('[data-testid="current-line"]');
          const currentEpisode = document.querySelector('[data-testid="current-episode"]');
          if (currentLine && activeButton) currentLine.textContent = activeButton.textContent || '';
          if (currentEpisode) currentEpisode.textContent = '未选择';
        };
        lineButtons.forEach((button) => button.addEventListener('click', () => activateLine(button.dataset.lineIndex || '0')));
        const orderButtons = [...document.querySelectorAll('[data-action="playback-order"]')];
        const setPlaybackOrder = (order) => {
          orderButtons.forEach((button) => {
            button.setAttribute('aria-pressed', String(button.dataset.order === order));
          });
          linePanels.forEach((panel) => {
            const episodes = [...panel.querySelectorAll('[data-action="player-episode"]')];
            episodes.sort((left, right) => {
              const difference = Number(left.dataset.episodeIndex) - Number(right.dataset.episodeIndex);
              return order === 'reverse' ? -difference : difference;
            }).forEach((episode) => panel.appendChild(episode));
          });
        };
        orderButtons.forEach((button) => button.addEventListener('click', () => setPlaybackOrder(button.dataset.order || 'forward')));
        document.querySelectorAll('[data-action="player-episode"]').forEach((button) => button.addEventListener('click', () => {
          void send('/api/player', {
            lineIndex: Number(button.dataset.lineIndex),
            episodeIndex: Number(button.dataset.episodeIndex),
            vipFlags: [],
          });
        }));
        document.querySelectorAll('[data-action="player-retry"]').forEach((button) => button.addEventListener('click', () => {
          void send('/api/player', {
            lineIndex: Number(button.dataset.lineIndex),
            episodeIndex: Number(button.dataset.episodeIndex),
            vipFlags: [],
          });
        }));
        document.querySelector('[data-action="search-form"]')?.addEventListener('submit', (event) => {
          event.preventDefault();
          const key = new FormData(event.currentTarget).get('key');
          void send('/api/search', { key: String(key || ''), page: 1, quick: false });
        });
      })();
    </script>
  </body>
</html>`;
}

function renderPlaybackCatalog(
  catalog: PlaybackCatalog,
  selection: PlaybackSelection | null,
  retryable: boolean,
): string {
  if (catalog.lines.length === 0) {
    return `<section data-testid="playback-selector" class="playback-selector">
      <strong>播放线路</strong><p data-testid="playback-empty">暂无可用选集</p>
    </section>`;
  }

  const selectedLineIndex = selection?.lineIndex ?? catalog.lines[0]?.index ?? 0;
  const currentLine = catalog.lines.find((line) => line.index === selectedLineIndex) ?? catalog.lines[0];
  const currentEpisode = currentLine && selection?.lineIndex === currentLine.index
    ? currentLine.episodes.find((episode) => episode.index === selection.episodeIndex)
    : undefined;
  const retry = retryable && selection
    ? `<button
        type="button"
        data-testid="playback-retry"
        data-action="player-retry"
        data-line-index="${selection.lineIndex}"
        data-episode-index="${selection.episodeIndex}">重试</button>`
    : "";
  const lineButtons = catalog.lines.map((line) => `<button
        type="button"
        data-action="playback-line"
        data-line-index="${line.index}"
        aria-pressed="${line.index === selectedLineIndex}">${escapeHtml(line.name)}</button>`).join("");
  const linePanels = catalog.lines.map((line) => `<div
      data-playback-line="${line.index}"
      ${line.index === selectedLineIndex ? "" : "hidden"}>
      ${line.episodes.length === 0
        ? `<p data-testid="playback-line-empty">暂无可用选集</p>`
        : line.episodes.map((episode) => `<button
          type="button"
          data-action="player-episode"
          data-line-index="${line.index}"
          data-episode-index="${episode.index}"
          data-play-flag="${escapeHtml(line.name)}"
          data-play-id="${escapeHtml(episode.id)}">${escapeHtml(episode.name)}</button>`).join("")}
    </div>`).join("");
  return `<section data-testid="playback-selector" class="playback-selector">
    <div data-testid="playback-lines" aria-label="播放线路">${lineButtons}</div>
    <p>当前线路：<span data-testid="current-line">${escapeHtml(currentLine?.name ?? "")}</span></p>
    <p>当前选集：<span data-testid="current-episode">${escapeHtml(currentEpisode?.name ?? "未选择")}</span></p>
    <div data-testid="playback-order" aria-label="剧集顺序">
      <button type="button" data-action="playback-order" data-order="forward" aria-pressed="true">正序</button>
      <button type="button" data-action="playback-order" data-order="reverse" aria-pressed="false">倒序</button>
      ${retry}
    </div>
    <div data-testid="playback-episodes">${linePanels}</div>
  </section>`;
}

function listFrom(response: SpiderResponse): Record<string, unknown>[] {
  if (!isRecord(response.result) || !Array.isArray(response.result.list)) return [];
  return response.result.list.filter(isRecord).map((item) => ({ ...item }));
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function displaySource(value: string): string {
  const text = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text.length <= 64 ? text : `${text.slice(0, 36)}…${text.slice(-12)}`;
  try {
    const url = new URL(text);
    return `${url.protocol}//${url.host}/…`;
  } catch {
    return text.length <= 64 ? text : `${text.slice(0, 36)}…${text.slice(-12)}`;
  }
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function indexValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("PLAYBACK_FORMAT_INVALID: playback selection index is invalid");
  }
  return value;
}

function clonePlaybackCatalog(catalog: PlaybackCatalog | null): PlaybackCatalog | null {
  if (!catalog) return null;
  return {
    lines: catalog.lines.map((line) => ({
      ...line,
      episodes: line.episodes.map((episode) => ({ ...episode })),
    })),
  };
}

function clonePlaybackSession(session: DesktopPlaybackSession | null): DesktopPlaybackSession | null {
  if (!session) return null;
  return {
    ...session,
    media: { ...session.media },
  };
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function playerMediaSyncFromRequest(body: Record<string, unknown>): PlayerMediaSync {
  const patch: PlayerMediaSync = {};
  if (isPlaybackStatus(body.status)) patch.status = body.status;
  if (typeof body.currentTime === "number") patch.currentTime = body.currentTime;
  if (typeof body.duration === "number") patch.duration = body.duration;
  if (typeof body.volume === "number") patch.volume = body.volume;
  if (typeof body.muted === "boolean") patch.muted = body.muted;
  if (isRecord(body.error)
    && typeof body.error.code === "string"
    && typeof body.error.message === "string") {
    patch.error = { code: body.error.code, message: body.error.message };
  }
  return patch;
}

function isPlaybackStatus(value: unknown): value is PlaybackStatus {
  return value === "idle"
    || value === "resolving"
    || value === "loading"
    || value === "playing"
    || value === "paused"
    || value === "ended"
    || value === "stopped"
    || value === "error";
}

function statePatchFromRequest(body: Record<string, unknown>): DesktopStatePatch {
  const page: PageStatePatch = {};
  if (isNavigation(body.navigation)) page.navigation = body.navigation;
  if (Object.prototype.hasOwnProperty.call(body, "siteKey")) {
    page.siteKey = typeof body.siteKey === "string" ? body.siteKey : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "category")) {
    page.category = parsePageContext(body.category);
  }
  if (Object.prototype.hasOwnProperty.call(body, "search")) {
    page.search = parseSearchContext(body.search);
  }
  if (typeof body.scrollTop === "number" && Number.isFinite(body.scrollTop)) {
    page.scrollTop = body.scrollTop;
  }
  if (Object.prototype.hasOwnProperty.call(body, "recentDetailId")) {
    page.recentDetailId = typeof body.recentDetailId === "string" ? body.recentDetailId : null;
  }
  return {
    ...(isThemeMode(body.theme) ? { theme: body.theme } : {}),
    page,
  };
}

function parsePageContext(value: unknown): { typeId: string; page: number } | null {
  if (!isRecord(value) || typeof value.typeId !== "string") return null;
  return {
    typeId: value.typeId,
    page: numberValue(value.page, 1),
  };
}

function parseSearchContext(value: unknown): { key: string; page: number } | null {
  if (!isRecord(value) || typeof value.key !== "string") return null;
  return {
    key: value.key,
    page: numberValue(value.page, 1),
  };
}

function isThemeMode(value: unknown): value is "system" | "light" | "dark" {
  return value === "system" || value === "light" || value === "dark";
}

function isNavigation(value: unknown): value is "home" | "category" | "search" | "detail" | "settings" {
  return value === "home"
    || value === "category"
    || value === "search"
    || value === "detail"
    || value === "settings";
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 1_000_000) throw new Error("Request body is too large");
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return isRecord(value) ? value : {};
}

function writeHtml(response: ServerResponse, html: string, status = 200): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function writeJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function errorLabel(code: string): string {
  if (code === "SPIDER_TIMEOUT") return "请求超时";
  if (code === "JVM_SPIDER_ERROR") return "Spider 请求失败";
  return "Spider 调用错误";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
