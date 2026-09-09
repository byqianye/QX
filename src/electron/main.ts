import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { app, BrowserWindow, dialog, net, screen, session as electronSession, shell as electronShell } from "electron";

import { JsonFileTrustPersistence, ImportTrustStore } from "../config/trust.js";
import type { TvBoxConfig } from "../config/decoder.js";
import { ConfigHistoryStore } from "../config/history.js";
import { DesktopSpiderImportController } from "../desktop/spider-import.js";
import { DesktopSpiderSession } from "../desktop/spider-session.js";
import { DesktopSpiderUiServer } from "../desktop/spider-ui.js";
import type { ParserCandidate } from "../desktop/parse-chain.js";
import type { PlaybackRule, PlaybackRuleAction, PlaybackRuleMatch, PlaybackRuleScope } from "../desktop/playback-rules.js";
import {
  restoreWindowBounds,
  type DesktopStateStorePort,
  type PersistedWindowState,
} from "../desktop/state-persistence.js";
import type { DesktopSpiderClientPort } from "../desktop/spider-client-port.js";
import type { PlaybackFallbackMode } from "../health/playback-health.js";
import { SourceHealthService } from "../health/source-health.js";
import { EngineRouter } from "../engine/engine-router.js";
import { SpiderArtifactCache } from "../spider/spider-artifact-cache.js";
import { NativeSpiderRuntime, SpiderRuntimeManager } from "../spider/spider-runtime.js";
import { readJellyfinEnvironment } from "../jellyfin/jellyfin-adapter.js";
import { resolveJavaExecutable } from "../spikes/java-probe.js";
import {
  runPackagedE2e,
  type PackagedE2eResult,
} from "./e2e-runner.js";
import { runFakeMpvExitProbe } from "./fake-mpv-probe.js";
import { resolveElectronRuntime, sanitizedPackagedPythonEnvironment } from "./runtime.js";
import { DesktopShellRuntime } from "./shell-runtime.js";
import { ProductionLogger } from "./production-logger.js";
import { RuntimePathResolver } from "./runtime-paths.js";
import { DataDirectoryResolver, DataStorageService, type DataDirectoryMode } from "../data/data-directory.js";
import {
  BackupRestoreService,
} from "../data/backup-restore.js";
import { EMPTY_BACKUP_UI_STATE, type BackupUiState } from "../backup-types.js";
import { SqliteConfigHistoryPersistence } from "../data/config-history-persistence.js";
import { SqliteDesktopStateStore } from "../data/desktop-state-store.js";
import { LegacyDataMigrator } from "../data/legacy-migration.js";
import { databaseError, isDataLayerError, type DataLayerError } from "../data/errors.js";
import {
  openSqliteDataLayer,
  type SqliteDataLayer,
} from "../data/sqlite.js";
import {
  CacheRepository,
  FavoritesRepository,
  FollowRepository,
  HistoryRepository,
  PlaybackProgressRepository,
  SettingsRepository,
} from "../data/repositories.js";
import { FavoritesService } from "../favorites/favorites-service.js";
import { HistoryProgressService } from "../history/history-progress.js";
import { FollowService } from "../follow/follow-service.js";
import { CacheService } from "../cache/cache-service.js";
import { DanmakuService } from "../danmaku/danmaku-service.js";
import { LocalMediaService } from "../local-media/local-media-service.js";
import { DownloadService, createDownloadBackend } from "../downloads/download-service.js";
import { PushService, PushServiceError } from "../push/push-service.js";
import type { PushRequest } from "../push/push-types.js";
import { CastMediaBridge } from "../cast/cast-media-bridge.js";
import { CastService, UdpSsdpTransport } from "../cast/cast-service.js";
import { WebControlService } from "../web-control/web-control-service.js";
import { WebSecurityManager } from "../web-control/web-security.js";
import {
  IsolatedSniffer,
  type IsolatedSnifferPlatform,
  type IsolatedSnifferSession,
  type SnifferNavigationEvent,
  type SnifferPolicy,
  type SnifferRequestEvent,
  type SnifferResponseEvent,
  type SnifferViolation,
} from "./isolated-sniffer.js";

const APP_NAME = "QX 影视";
const SMOKE_MODE = process.env.QX_ELECTRON_SMOKE === "1";
const E2E_MODE = process.env.QX_ELECTRON_E2E === "1";
const REQUEST_TIMEOUT_MS = numberEnvironment("QX_ELECTRON_REQUEST_TIMEOUT_MS", 30_000);
const STARTUP_TIMEOUT_MS = 5_000;
const PLAYBACK_PROXY_ORIGINS = listEnvironment("QX_PLAYBACK_PROXY_ORIGINS");
const PARSER_ALLOWED_ORIGINS = listEnvironment("QX_PARSE_ALLOWED_ORIGINS");
const PARSER_CANDIDATES = parserCandidatesEnvironment("QX_PARSE_CANDIDATES_JSON");
const PLAYBACK_RULES = playbackRulesEnvironment("QX_PLAYBACK_RULES_JSON");
const PLAYBACK_FALLBACK_MODE = playbackFallbackModeEnvironment("QX_PLAYBACK_FALLBACK_MODE");
const PLAYBACK_FALLBACK_MAX_ATTEMPTS = numberEnvironment("QX_PLAYBACK_FALLBACK_MAX_ATTEMPTS", 4);
const PLAYBACK_FALLBACK_TIMEOUT_MS = numberEnvironment("QX_PLAYBACK_FALLBACK_TIMEOUT_MS", 30_000);
const PUSH_TRUSTED_LOCAL_ORIGINS = listEnvironment("QX_PUSH_TRUSTED_LOCAL_ORIGINS");
const ISOLATED_SNIFFER_ENABLED = process.env.QX_SNIFF_ENABLED === "1";
const WEB_CONTROL_PORT = webControlPortEnvironment();

if (process.env.QX_E2E_USER_DATA) {
  mkdirSync(process.env.QX_E2E_USER_DATA, { recursive: true });
  app.setPath("userData", process.env.QX_E2E_USER_DATA);
}

let shell: DesktopShellRuntime | undefined;
let mainWindow: BrowserWindow | undefined;
let playerWindow: BrowserWindow | undefined;
let playerWindowUrl: string | undefined;
let uiServer: DesktopSpiderUiServer | undefined;
let isolatedSniffer: IsolatedSniffer | undefined;
let cleanupPromise: Promise<void> | undefined;
let quitting = false;
let lastClient: DesktopSpiderClientPort | undefined;
let engineRouter: EngineRouter | undefined;
let dataLayer: SqliteDataLayer | undefined;
let desktopStateStore: DesktopStateStorePort | undefined;
let configHistoryStore: ConfigHistoryStore | undefined;
let historyProgressService: HistoryProgressService | undefined;
let favoritesService: FavoritesService | undefined;
let followService: FollowService | undefined;
let cacheService: CacheService | undefined;
let danmakuService: DanmakuService | undefined;
let localMediaService: LocalMediaService | undefined;
let downloadService: DownloadService | undefined;
let pushService: PushService | undefined;
let castService: CastService | undefined;
let webControlService: WebControlService | undefined;
let webSecurity: WebSecurityManager | undefined;
let backupRestoreService: BackupRestoreService | undefined;
let backupState: BackupUiState = { ...EMPTY_BACKUP_UI_STATE };
let lastBackupPath: string | undefined;
let dataStorageService: DataStorageService | undefined;
let windowStateTimer: ReturnType<typeof setTimeout> | undefined;
let applicationLogger: ProductionLogger | undefined;
let runtimeLogger: ProductionLogger | undefined;
let playbackLogger: ProductionLogger | undefined;

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

process.on("uncaughtException", (error) => {
  getProductionLogger().error("FATAL_ERROR", error, { kind: "uncaughtException" });
  if (!app.isReady()) {
    app.exit(1);
    return;
  }
  void closeShell(true).finally(() => app.exit(1));
});

process.on("unhandledRejection", (reason) => {
  getProductionLogger().error("FATAL_ERROR", reason, { kind: "unhandledRejection" });
});

function getDesktopStateStore(): DesktopStateStorePort {
  initializeDataLayer();
  if (!desktopStateStore) throw new Error("Desktop state store is unavailable");
  return desktopStateStore;
}

function getConfigHistoryStore(): ConfigHistoryStore {
  initializeDataLayer();
  if (!configHistoryStore) throw new Error("Config history store is unavailable");
  return configHistoryStore;
}
function getHistoryProgressService(): HistoryProgressService {
  initializeDataLayer();
  if (!historyProgressService) throw new Error("History progress service is unavailable");
  return historyProgressService;
}
function getFavoritesService(): FavoritesService {
  initializeDataLayer();
  if (!favoritesService) throw new Error("Favorites service is unavailable");
  return favoritesService;
}
function getFollowService(): FollowService {
  initializeDataLayer();
  if (!followService) throw new Error("Follow service is unavailable");
  return followService;
}
function getCacheService(): CacheService {
  initializeDataLayer();
  if (!cacheService) throw new Error("Cache service is unavailable");
  return cacheService;
}
function getDanmakuService(): DanmakuService {
  initializeDataLayer();
  if (!danmakuService) throw new Error("Danmaku service is unavailable");
  return danmakuService;
}
function getLocalMediaService(): LocalMediaService {
  initializeDataLayer();
  if (!localMediaService) throw new Error("Local media service is unavailable");
  return localMediaService;
}
function getDataStorageService(): DataStorageService {
  if (!dataStorageService) {
    dataStorageService = new DataStorageService(new DataDirectoryResolver(app.getPath("userData"), {
      executablePath: process.execPath,
      packaged: app.isPackaged,
    }));
  }
  return dataStorageService;
}

function getBackupRestoreService(): BackupRestoreService {
  initializeDataLayer();
  if (!backupRestoreService) throw new Error("Backup service is unavailable");
  return backupRestoreService;
}

async function createBackup(includeCache: boolean): Promise<BackupUiState> {
  const service = getBackupRestoreService();
  if (!dataLayer) throw new Error("Backup data layer is unavailable");
  try {
    service.clearPreview();
    const result = await service.createBackup(dataLayer, { includeCache });
    lastBackupPath = join(getDataStorageService().directories().backups, result.fileName);
    backupState = {
      status: "idle",
      lastBackup: {
        fileName: result.fileName,
        size: result.size,
        createdAt: result.createdAt,
        includeCache: result.includeCache,
        summary: { ...result.summary },
      },
      preview: null,
      error: null,
    };
  } catch (error) {
    backupState = {
      ...backupState,
      status: "error",
      error: { code: errorCode(error, "BACKUP_CREATE_FAILED"), message: errorMessage(error) },
    };
  }
  return backupState;
}

async function pickBackup(): Promise<BackupUiState> {
  let selectedPath = E2E_MODE && lastBackupPath && existsSync(lastBackupPath) ? lastBackupPath : undefined;
  if (!selectedPath) {
    const picked = await dialog.showOpenDialog({
      title: "Restore QX backup",
      properties: ["openFile"],
      filters: [{ name: "QX backup", extensions: ["zip"] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return backupState;
    selectedPath = picked.filePaths[0];
  }
  try {
    const preview = getBackupRestoreService().preview(selectedPath);
    backupState = { ...backupState, status: "preview", preview, error: null };
  } catch (error) {
    backupState = {
      ...backupState,
      status: "error",
      preview: null,
      error: { code: errorCode(error, "BACKUP_PREVIEW_FAILED"), message: errorMessage(error) },
    };
  }
  return backupState;
}

function clearBackupPreview(): void {
  backupRestoreService?.clearPreview();
  backupState = { ...EMPTY_BACKUP_UI_STATE };
}

function requestBackupRestore(): void {
  setTimeout(() => {
    void (async () => {
      const service = backupRestoreService;
      try {
        if (!service) throw new Error("Backup service is unavailable");
        await closeShell(true);
        service.restore();
        app.relaunch();
        app.exit(0);
      } catch (error) {
        backupState = {
          ...backupState,
          status: "error",
          error: { code: errorCode(error, "BACKUP_RESTORE_FAILED"), message: errorMessage(error) },
        };
        app.relaunch();
        app.exit(1);
      }
    })();
  }, 0);
}

function errorCode(error: unknown, fallback: string): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : fallback;
}

function initializeDataLayer(): void {
  if (dataLayer && desktopStateStore && configHistoryStore && historyProgressService && favoritesService && followService && cacheService && danmakuService && localMediaService && downloadService && pushService && castService && webSecurity && backupRestoreService) return;
  const dataStorage = getDataStorageService();
  const directories = dataStorage.prepare();
  const opened = openSqliteDataLayer(directories.database);
  dataLayer = opened.layer;
  const settingsRepository = new SettingsRepository(opened.layer);
  webSecurity = new WebSecurityManager({ settings: settingsRepository });
  backupRestoreService = new BackupRestoreService({
    dataRoot: directories.dataRoot,
    databasePath: directories.database,
    backupsDirectory: directories.backups,
    tempDirectory: directories.temp,
    appVersion: app.getVersion(),
  });
  const legacy = new LegacyDataMigrator(opened.layer).migrate({
    desktopState: join(directories.dataRoot, "desktop-state.json"),
    configHistory: join(directories.dataRoot, "config-history.json"),
    sourceHealth: join(directories.dataRoot, "source-health.json"),
    streamHealth: join(directories.dataRoot, "stream-health.json"),
  });
  let historyDiagnostic: DataLayerError | null = null;
  try {
    configHistoryStore = new ConfigHistoryStore(new SqliteConfigHistoryPersistence(opened.layer));
  } catch (error) {
    // A malformed history row must not prevent the rest of the application from starting.
    configHistoryStore = new ConfigHistoryStore();
    historyDiagnostic = isDataLayerError(error)
      ? error
      : databaseError("DATABASE_CORRUPT", error);
  }
  const diagnostic = opened.diagnostic ?? legacy.diagnostic ?? historyDiagnostic;
  desktopStateStore = new SqliteDesktopStateStore(opened.layer, diagnostic);
  historyProgressService = new HistoryProgressService({
    db: opened.layer,
    history: new HistoryRepository(opened.layer),
    progress: new PlaybackProgressRepository(opened.layer),
    settings: new SettingsRepository(opened.layer),
  });
  favoritesService = new FavoritesService({
    db: opened.layer,
    favorites: new FavoritesRepository(opened.layer),
    history: new HistoryRepository(opened.layer),
  });
  followService = new FollowService({
    db: opened.layer,
    follow: new FollowRepository(opened.layer),
    history: new HistoryRepository(opened.layer),
  });
  cacheService = new CacheService({
    root: directories.cache,
    repository: new CacheRepository(opened.layer),
  });
  danmakuService = new DanmakuService({
    settings: new SettingsRepository(opened.layer),
  });
  localMediaService = new LocalMediaService({ db: opened.layer });
  downloadService = new DownloadService({
    db: opened.layer,
    backend: createDownloadBackend({ ...process.env, QX_RUNTIME_DIRECTORY: runtimeDirectory() }),
  });
  pushService = new PushService({
    settings: settingsRepository,
    ...(webSecurity ? { security: webSecurity } : {}),
    ...(PUSH_TRUSTED_LOCAL_ORIGINS.length > 0 ? { trustedLocalOrigins: PUSH_TRUSTED_LOCAL_ORIGINS } : {}),
    playback: {
      getActiveSession: () => uiServer?.pushPlaybackSession() ?? null,
      play: async (request: PushRequest) => {
        if (!uiServer) throw new PushServiceError("PUSH_PLAYBACK_UNAVAILABLE", "桌面播放服务尚未启动。");
        return uiServer.replacePush(request);
      },
    },
  });
  const castSsdpPort = numberEnvironment("QX_E2E_CAST_SSDP_PORT", 1900);
  castService = new CastService({
    ...(process.env.QX_E2E_CAST_SSDP_PORT ? {
      transport: new UdpSsdpTransport({ address: "127.0.0.1", port: castSsdpPort }),
    } : {}),
    bridge: new CastMediaBridge({
      bindHost: "0.0.0.0",
      advertisedHost: castAdvertisedHost(),
    }),
  });
}

function createShell(): DesktopShellRuntime {
  const stateStore = getDesktopStateStore();
  const trustStore = new ImportTrustStore(
    new JsonFileTrustPersistence(join(getDataStorageService().directories().dataRoot, "trusted-sources.json")),
  );
  const configHistory = getConfigHistoryStore();

  return new DesktopShellRuntime({
    resolveRuntime: () => resolveElectronRuntime(
      runtimeDirectory(),
      forceExternalJavaDisabled() ? () => null : resolveJavaExecutable,
      {
        allowBundledJre: !forceBundledJreDisabled(),
        allowExternalJava: !app.isPackaged && !forceExternalJavaDisabled(),
        requireBundledRuntimeManifest: app.isPackaged,
      },
    ),
    createServer: (runtime) => {
      const router = new EngineRouter({ maxActiveSessions: 4, idleSessionMs: 30_000 });
      const jellyfinConfig = readJellyfinEnvironment(process.env);
      engineRouter = router;
      const spiderCachePath = join(getDataStorageService().directories().dataRoot, "spider-cache");
      const createRuntimeManager = (config: TvBoxConfig, sourceUrl?: string) => {
        return new SpiderRuntimeManager({
          config,
          ...(sourceUrl ? { sourceUrl } : {}),
          artifactCache: new SpiderArtifactCache(spiderCachePath, { timeoutMs: REQUEST_TIMEOUT_MS }),
          pythonExecutable: runtime.pythonExecutable ?? (app.isPackaged ? "" : process.env.QX_PYTHON ?? "python"),
        nativeRuntime: async (nativeSite) => {
          const binding = router.resolve(config, nativeSite);
          if (binding.engine !== "jvm") return undefined;
          const siteKey = typeof nativeSite.key === "string" && nativeSite.key.trim()
            ? nativeSite.key.trim()
            : nativeSite.api ?? "native";
          const client = await router.acquireClient(binding, {
            sourceId: sourceUrl ?? "runtime-config",
            siteKey,
            sessionId: randomUUID(),
            binding,
            ...(binding.definition ? { definition: binding.definition } : {}),
          }, {
            javaExecutable: runtime.javaExecutable,
            hostJar: runtime.hostJar,
            spiderJar: runtime.spiderJar,
            spiderClass: runtime.spiderClass,
            pythonExecutable: runtime.pythonExecutable ?? (app.isPackaged ? "" : process.env.QX_PYTHON ?? "python"),
            ...(app.isPackaged ? { pythonEnvironment: sanitizedPackagedPythonEnvironment(process.env) } : {}),
            ...(jellyfinConfig ? { jellyfinConfig } : {}),
            requestTimeoutMs: REQUEST_TIMEOUT_MS,
            startupTimeoutMs: STARTUP_TIMEOUT_MS,
          });
          lastClient = client;
          return new NativeSpiderRuntime(client, binding.capabilities, {
            runtime: "native",
            supported: true,
            reason: "native_supported",
            capabilities: binding.capabilities,
          });
        },
        });
      };
      const importer: DesktopSpiderImportController = new DesktopSpiderImportController({
        trustStore,
        history: configHistory,
        autoRefresh: process.env.QX_CONFIG_AUTO_REFRESH === "1",
        refreshIntervalMs: numberEnvironment("QX_CONFIG_REFRESH_INTERVAL_MS", 6 * 60 * 60 * 1000),
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        sourceHealth: new SourceHealthService({
          storePath: join(getDataStorageService().directories().dataRoot, "source-health.json"),
        }),
        runtimeManagerFactory: createRuntimeManager,
        preferredSiteKey: () => stateStore.state.page.siteKey,
        createSession: (source, config, site, assessment, health) => new DesktopSpiderSession({
          source,
          config,
          trustStore,
          ...(assessment ? { assessment } : {}),
          ...(health ? { health } : {}),
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          createClient: async (selectedSite, context) => {
            if (!context) throw new Error(`Missing engine binding for ${selectedSite.api ?? site.api ?? ""}`);
            const client = await router.acquireClient(context.binding, context, {
              javaExecutable: runtime.javaExecutable,
              hostJar: runtime.hostJar,
              spiderJar: runtime.spiderJar,
              spiderClass: runtime.spiderClass,
              pythonExecutable: runtime.pythonExecutable ?? (app.isPackaged ? "" : process.env.QX_PYTHON ?? "python"),
              ...(app.isPackaged ? { pythonEnvironment: sanitizedPackagedPythonEnvironment(process.env) } : {}),
              ...(jellyfinConfig ? { jellyfinConfig } : {}),
              requestTimeoutMs: REQUEST_TIMEOUT_MS,
              startupTimeoutMs: STARTUP_TIMEOUT_MS,
            });
            lastClient = client;
            return client;
          },
          createRuntime: async (selectedSite) => importer.getRuntimeForSite(selectedSite),
        }),
      });
      const sniffer = ISOLATED_SNIFFER_ENABLED
        ? new IsolatedSniffer(createElectronSnifferPlatform())
        : undefined;
      isolatedSniffer = sniffer;
      const server = new DesktopSpiderUiServer({
        importer,
        rendererDirectory: runtimePaths().getRendererPath(),
        stateStore,
        history: getHistoryProgressService(),
        favorites: getFavoritesService(),
        follow: getFollowService(),
        cache: getCacheService(),
        storage: getDataStorageService(),
        danmaku: getDanmakuService(),
        localMedia: getLocalMediaService(),
        ...(downloadService ? { downloads: downloadService } : {}),
        ...(pushService ? { push: pushService } : {}),
        ...(castService ? { cast: castService } : {}),
        onStorageOpen: async () => {
          await electronShell.openPath(getDataStorageService().directories().dataRoot);
        },
        onStorageSwitch: requestStorageSwitch,
        onBackupCreate: createBackup,
        onBackupPick: pickBackup,
        onBackupApply: requestBackupRestore,
        onBackupClear: clearBackupPreview,
        onBackupOpen: async () => {
          await electronShell.openPath(getDataStorageService().directories().backups);
        },
        onLocalFilePicker: async () => {
          if (process.env.QX_E2E_LOCAL_MEDIA_FILE) return [process.env.QX_E2E_LOCAL_MEDIA_FILE];
          const selected = await dialog.showOpenDialog({
            title: "打开本地媒体",
            properties: ["openFile", "multiSelections"],
            filters: [{ name: "媒体文件", extensions: ["mp4", "mkv", "webm", "mov", "m4v", "m3u8", "mp3", "wav", "flac", "ogg", "m4a"] }],
          });
          return selected.canceled ? [] : selected.filePaths;
        },
        onLocalFolderPicker: async () => {
          const selected = await dialog.showOpenDialog({
            title: "添加本地媒体目录",
            properties: ["openDirectory"],
          });
          return selected.canceled ? null : selected.filePaths[0] ?? null;
        },
        onDownloadFolderPicker: async () => {
          if (process.env.QX_E2E_DOWNLOAD_DIR) return process.env.QX_E2E_DOWNLOAD_DIR;
          const selected = await dialog.showOpenDialog({
            title: "选择下载目录",
            properties: ["openDirectory", "createDirectory"],
          });
          return selected.canceled ? null : selected.filePaths[0] ?? null;
        },
        onDownloadFolderOpen: async (directoryPath) => {
          const error = await electronShell.openPath(directoryPath);
          if (error) throw new Error("DOWNLOAD_OPEN_FOLDER_FAILED");
        },
        onPlayerOpen: openPlayerWindow,
        onPlayerAttach: closePlayerWindow,
        onPlayerStop: closePlayerWindow,
        ...(PLAYBACK_PROXY_ORIGINS.length > 0 ? { playbackProxyOrigins: PLAYBACK_PROXY_ORIGINS } : {}),
        ...(PARSER_CANDIDATES.length > 0 ? { parserCandidates: PARSER_CANDIDATES } : {}),
        ...(PARSER_ALLOWED_ORIGINS.length > 0 ? { parserAllowedOrigins: PARSER_ALLOWED_ORIGINS } : {}),
        playbackFetch: (input, init) => {
          const requestUrl = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
          return requestUrl.startsWith("https:")
            ? net.fetch(input instanceof URL ? input.toString() : input, init)
            : fetch(input, init);
        },
        ...(PLAYBACK_RULES.length > 0 ? { playbackRules: PLAYBACK_RULES } : {}),
        ...(sniffer ? { sniffer } : {}),
        playbackFallbackMode: PLAYBACK_FALLBACK_MODE,
        playbackFallbackMaxAttempts: PLAYBACK_FALLBACK_MAX_ATTEMPTS,
        playbackFallbackTimeoutMs: PLAYBACK_FALLBACK_TIMEOUT_MS,
      });
      uiServer = server;
      return server;
    },
  });
}

async function ensureWebControl(): Promise<void> {
  if (!uiServer) throw new Error("Web control backend is unavailable before the desktop server starts");
  if (!webControlService) {
    webControlService = new WebControlService({
      backend: uiServer.webControlBackend(),
      ...(webSecurity ? { security: webSecurity } : {}),
      port: WEB_CONTROL_PORT,
    });
  } else {
    webControlService.setBackend(uiServer.webControlBackend());
  }
  await webControlService.start();
}

function createElectronSnifferPlatform(): IsolatedSnifferPlatform {
  return {
    createSession: (policy) => createElectronSnifferSession(policy),
  };
}

async function createElectronSnifferSession(policy: SnifferPolicy): Promise<IsolatedSnifferSession> {
  const isolatedSession = electronSession.fromPartition(policy.partition, { cache: false });
  const window = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: false,
    webPreferences: {
      session: isolatedSession,
      contextIsolation: policy.contextIsolation,
      nodeIntegration: policy.nodeIntegration,
      sandbox: policy.sandbox,
      webSecurity: policy.webSecurity,
    },
  });
  const requestListeners = new Set<(event: SnifferRequestEvent) => void>();
  const responseListeners = new Set<(event: SnifferResponseEvent) => void>();
  const navigationListeners = new Set<(event: SnifferNavigationEvent) => void>();
  const violationListeners = new Set<(event: SnifferViolation) => void>();
  const requests = new Map<number, {
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string[]>;
    startedAt: number;
  }>();
  let closed = false;

  const emitViolation = (event: SnifferViolation) => {
    for (const listener of violationListeners) listener(event);
  };
  const emitRequest = (event: SnifferRequestEvent) => {
    for (const listener of requestListeners) listener(event);
  };
  const emitResponse = (event: SnifferResponseEvent) => {
    for (const listener of responseListeners) listener(event);
  };
  const emitNavigation = (event: SnifferNavigationEvent) => {
    for (const listener of navigationListeners) listener(event);
  };
  const classifyUrl = (url: string): "allowed" | "origin" | "protocol" | "local-file" => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "protocol";
    }
    if (parsed.protocol === "file:") return "local-file";
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "protocol";
    return policy.allowedOrigins.includes(parsed.origin) ? "allowed" : "origin";
  };
  const onBeforeRequest = (
    details: Electron.OnBeforeRequestListenerDetails,
    callback: (response: Electron.CallbackResponse) => void,
  ) => {
    const classification = classifyUrl(details.url);
    if (classification !== "allowed") {
      emitViolation({
        kind: classification === "local-file" ? "local-file" : classification,
        url: details.url,
        message: classification === "origin"
          ? "隔离嗅探阻止了 allowlist 外请求"
          : "隔离嗅探阻止了非 HTTP(S) 请求",
      });
      callback({ cancel: true });
      return;
    }
    requests.set(details.id, { startedAt: Date.now() });
    emitRequest({
      requestId: String(details.id),
      url: details.url,
      method: details.method,
      resourceType: details.resourceType,
      ...(details.referrer ? { pageUrl: details.referrer } : {}),
      isMainFrame: details.resourceType === "mainFrame",
    });
    callback({});
  };
  const onBeforeSendHeaders = (
    details: Electron.OnBeforeSendHeadersListenerDetails,
    callback: (response: Electron.BeforeSendResponse) => void,
  ) => {
    const request = requests.get(details.id) ?? { startedAt: Date.now() };
    request.requestHeaders = { ...details.requestHeaders };
    requests.set(details.id, request);
    callback({ requestHeaders: details.requestHeaders });
  };
  const onHeadersReceived = (
    details: Electron.OnHeadersReceivedListenerDetails,
    callback: (response: Electron.HeadersReceivedResponse) => void,
  ) => {
    const request = requests.get(details.id) ?? { startedAt: Date.now() };
    if (details.responseHeaders) request.responseHeaders = { ...details.responseHeaders };
    requests.set(details.id, request);
    callback(details.responseHeaders ? { responseHeaders: details.responseHeaders } : {});
  };
  const onCompleted = (details: Electron.OnCompletedListenerDetails) => {
    const request = requests.get(details.id);
    requests.delete(details.id);
    const headers = details.responseHeaders ?? request?.responseHeaders;
    const contentType = firstHeader(headers, "content-type");
    const contentLengthValue = firstHeader(headers, "content-length");
    const contentLength = contentLengthValue ? Number(contentLengthValue) : undefined;
    emitResponse({
      requestId: String(details.id),
      url: details.url,
      method: details.method,
      resourceType: details.resourceType,
      ...(details.referrer ? { pageUrl: details.referrer } : {}),
      isMainFrame: details.resourceType === "mainFrame",
      statusCode: details.statusCode,
      ...(headers ? { responseHeaders: headers } : {}),
      ...(contentType ? { contentType } : {}),
      ...(contentLength !== undefined && Number.isFinite(contentLength) ? { contentLength } : {}),
      ...(request?.requestHeaders ? { requestHeaders: request.requestHeaders } : {}),
      ...(request ? { durationMs: Date.now() - request.startedAt } : {}),
      explicitPlayerRequest: details.resourceType === "media",
      isMasterPlaylist: /\.m3u8(?:$|[?#])/i.test(details.url),
    });
  };
  const onErrorOccurred = (details: Electron.OnErrorOccurredListenerDetails) => {
    requests.delete(details.id);
  };
  const onWillNavigate = (event: Electron.Event, url: string) => {
    const classification = classifyUrl(url);
    if (classification !== "allowed") {
      event.preventDefault();
      emitViolation({
        kind: classification === "local-file" ? "local-file" : "navigation",
        url,
        message: "隔离嗅探阻止了不在 allowlist 内的页面导航",
      });
      return;
    }
    emitNavigation({ url, isMainFrame: true });
  };
  const onDownload = (event: Electron.Event) => {
    event.preventDefault();
    emitViolation({ kind: "download", message: "隔离嗅探禁用了下载" });
  };

  isolatedSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, onBeforeRequest);
  isolatedSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, onBeforeSendHeaders);
  isolatedSession.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, onHeadersReceived);
  isolatedSession.webRequest.onCompleted({ urls: ["<all_urls>"] }, onCompleted);
  isolatedSession.webRequest.onErrorOccurred({ urls: ["<all_urls>"] }, onErrorOccurred);
  isolatedSession.on("will-download", onDownload);
  window.webContents.on("will-navigate", onWillNavigate);
  window.webContents.setWindowOpenHandler((details) => {
    emitViolation({ kind: "popup", url: details.url, message: "隔离嗅探禁用了弹窗和新窗口" });
    return { action: "deny" };
  });

  return {
    load: async (url, headers) => {
      if (closed) throw new Error("Isolated sniffer session is closed");
      const safeHeaders = Object.entries(headers ?? {})
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n");
      await window.loadURL(url, safeHeaders ? { extraHeaders: safeHeaders } : undefined);
    },
    onRequest: (listener) => {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    onResponse: (listener) => {
      responseListeners.add(listener);
      return () => responseListeners.delete(listener);
    },
    onNavigate: (listener) => {
      navigationListeners.add(listener);
      return () => navigationListeners.delete(listener);
    },
    onViolation: (listener) => {
      violationListeners.add(listener);
      return () => violationListeners.delete(listener);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      isolatedSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, null);
      isolatedSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, null);
      isolatedSession.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, null);
      isolatedSession.webRequest.onCompleted({ urls: ["<all_urls>"] }, null);
      isolatedSession.webRequest.onErrorOccurred({ urls: ["<all_urls>"] }, null);
      isolatedSession.removeListener("will-download", onDownload);
      window.webContents.removeListener("will-navigate", onWillNavigate);
      requests.clear();
      try {
        if (!window.isDestroyed()) {
          window.webContents.stop();
          window.destroy();
        }
      } finally {
        await isolatedSession.clearStorageData().catch(() => undefined);
      }
    },
  };
}

function firstHeader(headers: Record<string, string[]> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const expected = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1];
  return entry?.[0];
}

function runtimeDirectory(): string {
  return runtimePaths().getRuntimePath();
}

function runtimePaths(): RuntimePathResolver {
  return new RuntimePathResolver({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    isPackaged: app.isPackaged,
  });
}

function getProductionLogger(): ProductionLogger {
  if (!applicationLogger) {
    applicationLogger = new ProductionLogger({ directory: runtimePaths().getLogPath() });
  }
  return applicationLogger;
}

function getRuntimeLogger(): ProductionLogger {
  if (!runtimeLogger) {
    runtimeLogger = new ProductionLogger({ directory: runtimePaths().getLogPath(), fileName: "runtime.log" });
  }
  return runtimeLogger;
}

function getPlaybackLogger(): ProductionLogger {
  if (!playbackLogger) {
    playbackLogger = new ProductionLogger({ directory: runtimePaths().getLogPath(), fileName: "playback.log" });
  }
  return playbackLogger;
}

function logAppStart(): void {
  const paths = runtimePaths();
  getProductionLogger().info("APP_START", {
    electronVersion: process.versions.electron,
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: paths.getUserDataPath(),
    runtimePath: paths.getRuntimePath(),
    runtimeManifest: existsSync(paths.getRuntimePath("runtime-manifest.json")),
    localProxy: "dynamic-port",
    spiderRuntime: existsSync(paths.getRuntimePath("jvm-spider-host.jar")) ? "available" : "missing",
    mpvPath: paths.getRuntimePath("mpv/mpv.exe"),
    mpvAvailable: existsSync(paths.getRuntimePath("mpv/mpv.exe")),
  });
  getRuntimeLogger().info("RUNTIME_LOG_READY");
  getPlaybackLogger().info("PLAYBACK_LOG_READY");
}

function forceExternalJavaDisabled(): boolean {
  return process.env.QX_ELECTRON_FORCE_NO_EXTERNAL_JAVA === "1"
    || process.env.QX_ELECTRON_FORCE_NO_JDK === "1";
}

function forceBundledJreDisabled(): boolean {
  return process.env.QX_ELECTRON_FORCE_NO_BUNDLED_JRE === "1";
}

async function closeShell(closeData = false): Promise<void> {
  if (!cleanupPromise) {
      cleanupPromise = (async () => {
        await closePlayerWindow();
        await shell?.close();
        await engineRouter?.destroyAll();
      })();
  }
  await cleanupPromise;
  if (closeData) await closeDataLayer();
}

async function closeDataLayer(): Promise<void> {
  await webControlService?.close().catch(() => undefined);
  await castService?.close().catch(() => undefined);
  await pushService?.close().catch(() => undefined);
  await downloadService?.close().catch(() => undefined);
  danmakuService?.close();
  historyProgressService?.appClose();
  historyProgressService = undefined;
  favoritesService = undefined;
  followService = undefined;
  cacheService = undefined;
  danmakuService = undefined;
  localMediaService = undefined;
  downloadService = undefined;
  pushService = undefined;
  castService = undefined;
  webControlService = undefined;
  webSecurity = undefined;
  backupRestoreService = undefined;
  dataStorageService = undefined;
  const current = dataLayer;
  dataLayer = undefined;
  if (!current) return;
  try {
    current.close();
  } catch {
    // Shutdown must remain idempotent; the data layer already mapped operation errors.
  }
}

function requestStorageSwitch(mode: DataDirectoryMode): void {
  setTimeout(() => {
    void (async () => {
      const storage = dataStorageService;
      if (!storage || storage.directories().mode === mode) return;
      try {
        await closeShell(true);
        storage.migrateTo(mode);
        app.relaunch();
        app.exit(0);
      } catch (error) {
        if (E2E_MODE) {
          writeE2eResult({ status: "failed", reason: "DATA_MIGRATION_FAILED", message: errorMessage(error) });
        } else {
          dialog.showErrorBox(APP_NAME, errorMessage(error));
        }
        app.quit();
      }
    })();
  }, 0);
}

async function openPlayerWindow(): Promise<void> {
  if (!playerWindowUrl) throw new Error("Player window is unavailable before the main window starts");
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.focus();
    return;
  }

  const iconPath = brandIconPath();
  const child = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 1024,
    minHeight: 720,
    show: !SMOKE_MODE && !E2E_MODE,
    title: `${APP_NAME} · 播放`,
    ...(iconPath ? { icon: iconPath } : {}),
    ...(mainWindow ? { parent: mainWindow } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  playerWindow = child;
  child.on("closed", () => {
    if (playerWindow === child) playerWindow = undefined;
    uiServer?.attachPlayerHost();
    notifyMainPlayerAttached();
  });

  try {
    await child.loadURL(new URL("?player-window=1", playerWindowUrl).toString());
  } catch (error) {
    if (!child.isDestroyed()) child.destroy();
    throw error;
  }
}

async function closePlayerWindow(): Promise<void> {
  const child = playerWindow;
  if (!child || child.isDestroyed()) {
    playerWindow = undefined;
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("closed", finish);
    child.close();
    if (child.isDestroyed()) finish();
  });
}

function notifyMainPlayerAttached(): void {
  if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
  void mainWindow.webContents.executeJavaScript(
    "window.dispatchEvent(new Event('qx-player-attached'))",
  ).catch(() => undefined);
}

async function createMainWindow(): Promise<void> {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }

  shell ??= createShell();
  const started = await shell.start();
  if (started.status !== "running" || !started.url) {
    getProductionLogger().error("STARTUP_ERROR", new Error(started.error?.message ?? "桌面 UI server 启动失败。"), {
      code: started.error?.code ?? "UI_SERVER_START_ERROR",
    });
    if (await recoverDataDirectoryStartup(started.error?.code)) {
      await shell.close();
      shell = undefined;
      return createMainWindow();
    }
    if (E2E_MODE) {
      writeE2eResult({
        status: "blocked",
        reason: started.error?.code ?? "UI_SERVER_START_ERROR",
        message: started.error?.message ?? "桌面 UI server 启动失败。",
      });
    } else {
      dialog.showErrorBox(
        APP_NAME,
        started.error?.message ?? "桌面 UI server 启动失败。",
      );
    }
    await closeShell(true);
    app.quit();
    return;
  }
  const uiUrl = started.url;
  playerWindowUrl = uiUrl;
  const persisted = getDesktopStateStore().state;
  const displays = screen.getAllDisplays().map((display) => display.workArea);
  const restoredBounds = restoreWindowBounds(persisted.window, displays, screen.getPrimaryDisplay().workArea);

  const iconPath = brandIconPath();
  mainWindow = new BrowserWindow({
    ...restoredBounds,
    minWidth: 960,
    minHeight: 640,
    show: !SMOKE_MODE && !E2E_MODE,
    title: APP_NAME,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.on("move", queueWindowStatePersistence);
  mainWindow.on("resize", queueWindowStatePersistence);
  mainWindow.on("maximize", queueWindowStatePersistence);
  mainWindow.on("unmaximize", queueWindowStatePersistence);
  mainWindow.on("close", persistWindowStateNow);
  if (persisted.window.isMaximized) mainWindow.maximize();
  mainWindow.on("closed", () => {
    clearWindowStateTimer();
    mainWindow = undefined;
    void closeShell();
  });
  mainWindow.webContents.once("did-finish-load", () => {
    void (async () => {
      try {
        await ensureWebControl();
        getPlaybackLogger().info("LOCAL_PROXY_STATUS", {
          uiServer: uiUrl,
          webControlPort: webControlService?.port ?? null,
          spiderRuntime: shell?.state.status === "running" ? "running" : "error",
        });
      } catch (error) {
        if (E2E_MODE) {
          writeE2eResult({ status: "blocked", reason: "WEB_CONTROL_START_ERROR", message: errorMessage(error) });
        } else {
          dialog.showErrorBox(APP_NAME, errorMessage(error));
        }
        await closeShell(true);
        app.quit();
        return;
      }
      if (E2E_MODE) {
        if (process.env.QX_E2E_SCENARIO === "network-timeout") {
          void runNetworkTimeoutE2e(uiUrl);
        } else {
          void runE2e(uiUrl);
        }
        return;
      }
      if (SMOKE_MODE) {
        console.log("electron-smoke: ready");
        void closeShell().finally(() => app.quit());
      }
    })();
  });

  try {
    await mainWindow.loadURL(uiUrl);
  } catch (error) {
    if (E2E_MODE) {
      writeE2eResult({ status: "failed", reason: "UI_LOAD_ERROR", message: errorMessage(error) });
    } else {
      dialog.showErrorBox(APP_NAME, errorMessage(error));
    }
    await closeShell(true);
    app.quit();
  }
}

function brandIconPath(): string | undefined {
  return runtimePaths().getBrandIconCandidates().find((candidate) => existsSync(candidate));
}

async function recoverDataDirectoryStartup(code: string | undefined): Promise<boolean> {
  if (E2E_MODE || code !== "PORTABLE_DATA_NOT_WRITABLE") return false;
  const choice = await dialog.showMessageBox({
    type: "error",
    title: APP_NAME,
    message: "Portable data directory is not writable.",
    detail: "Choose normal mode, select another data directory, or exit.",
    buttons: ["Use normal mode", "Choose data directory", "Exit"],
    defaultId: 0,
    cancelId: 2,
  });
  const storage = getDataStorageService();
  if (choice.response === 0) {
    storage.selectMode("normal");
    return true;
  }
  if (choice.response === 1) {
    const picked = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    const dataRoot = picked.filePaths[0];
    if (picked.canceled || !dataRoot) return false;
    storage.selectMode("normal", dataRoot);
    return true;
  }
  return false;
}

app.on("before-quit", (event) => {
  if (quitting) return;
  if (!shell || shell.state.status === "closed") {
    event.preventDefault();
    quitting = true;
    void closeDataLayer().finally(() => app.quit());
    return;
  }
  event.preventDefault();
  quitting = true;
  persistWindowStateNow();
  void closeShell(true).finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  void createMainWindow();
});

void app.whenReady().then(async () => {
  logAppStart();
  await createMainWindow();
}).catch(async (error: unknown) => {
  getProductionLogger().error("STARTUP_ERROR", error, { code: "APP_READY_ERROR" });
  if (E2E_MODE) {
    writeE2eResult({ status: "failed", reason: "APP_READY_ERROR", message: errorMessage(error) });
  } else {
    dialog.showErrorBox(APP_NAME, errorMessage(error));
  }
  await closeShell(true);
  app.quit();
});

async function runE2e(baseUrl: string): Promise<void> {
  let initialRendererRead = true;
  try {
    const result = await runPackagedE2e({
      baseUrl,
      configUrl: requiredEnvironment("QX_E2E_CONFIG_URL"),
      configFile: requiredEnvironment("QX_E2E_CONFIG_FILE"),
      configJson: requiredEnvironment("QX_E2E_CONFIG_JSON"),
      freshTrust: process.env.QX_E2E_FRESH_TRUST !== "0",
      startAgain: async () => {
        const startedAgain = await shell?.start();
        if (!startedAgain || startedAgain.status !== "running" || !startedAgain.url) {
          throw new Error("Repeated Electron shell start did not return a running URL");
        }
        await ensureWebControl();
        return { url: startedAgain.url };
      },
      closeWindow: async () => {
        // Keep the main window alive until the runner writes its result. The
        // final app.quit() below then performs the normal before-quit cleanup.
        await closeShell();
      },
      getSidecarPid: () => lastClient?.pid ?? null,
      waitForSidecarExit: waitForProcessExit,
      resourceCleanup: async () => ({
        proxySessions: uiServer?.resourceCounts.playbackProxySessions ?? 0,
        snifferSessions: uiServer?.resourceCounts.snifferSessions ?? isolatedSniffer?.activeSessionCount ?? 0,
      }),
      reloadWindow: async () => {
        if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Main window is unavailable for playback probe");
        await mainWindow.loadURL(baseUrl);
      },
      evaluateWindow: async (script) => {
        if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Main window is unavailable for playback probe");
        return mainWindow.webContents.executeJavaScript(script);
      },
      ...(process.env.QX_E2E_CAPTURE_DIR ? { captureWindow: captureE2eWindow } : {}),
      readWindowHtml: async () => {
        if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Main window is unavailable for renderer probe");
        if (initialRendererRead) initialRendererRead = false;
        else await mainWindow.loadURL(baseUrl);
        return mainWindow.webContents.executeJavaScript(`(() => new Promise((resolve, reject) => {
          const started = Date.now();
          const read = () => {
            const root = document.querySelector('[data-testid="vue-renderer"]');
            if (root?.getAttribute('data-ready') === 'true'
              && root.getAttribute('data-pending') === '') {
              resolve(document.documentElement.outerHTML);
              return;
            }
            if (Date.now() - started > 5000) {
              reject(new Error('Vue renderer did not become ready'));
              return;
            }
            window.setTimeout(read, 25);
          };
          read();
        }))()`);
      },
      verifyPlaybackRules: PLAYBACK_RULES.length > 0,
      verifyPlaybackDebug: Boolean(process.env.QX_E2E_PLAYBACK_CONFIG),
      verifySubtitleTracks: Boolean(process.env.QX_E2E_PLAYBACK_CONFIG),
      verifyDanmaku: Boolean(process.env.QX_E2E_PLAYBACK_CONFIG),
      verifyPlaybackHealth: Boolean(process.env.QX_E2E_PLAYBACK_CONFIG),
      verifyPlaybackFallback: Boolean(process.env.QX_E2E_PLAYBACK_CONFIG),
      verifyHistory: Boolean(process.env.QX_E2E_PLAYBACK_CONFIG),
      verifyFavorites: Boolean(process.env.QX_E2E_PLAYBACK_CONFIG),
      verifyFollow: Boolean(process.env.QX_E2E_PLAYBACK_CONFIG),
      verifyCache: true,
      verifyStorage: true,
      verifyBackup: process.env.QX_E2E_BACKUP === "1",
      ...(process.env.QX_E2E_EXPECTED_FAVORITE_ID
        ? { expectedFavoriteId: process.env.QX_E2E_EXPECTED_FAVORITE_ID }
        : {}),
      ...(process.env.QX_E2E_EXPECTED_FOLLOW_ID
        ? { expectedFollowIdentity: process.env.QX_E2E_EXPECTED_FOLLOW_ID }
        : {}),
      verifyParserFallback: Boolean(process.env.QX_E2E_PLAYBACK_CONFIG),
      verifySniffFallback: Boolean(process.env.QX_E2E_PLAYBACK_CONFIG) && ISOLATED_SNIFFER_ENABLED,
      verifyAggregateSearch: true,
      verifyFakeMpv: process.env.QX_E2E_FAKE_MPV === "1",
      ...(process.env.QX_E2E_FAKE_MPV === "1" ? { fakeMpv: runFakeMpvExitProbe } : {}),
      verifyLocalMedia: Boolean(process.env.QX_E2E_LOCAL_MEDIA_FILE),
      ...(process.env.QX_E2E_LOCAL_MEDIA_FILE ? { localMediaFile: process.env.QX_E2E_LOCAL_MEDIA_FILE } : {}),
      verifyDownloads: Boolean(process.env.QX_E2E_DOWNLOAD_DIR),
      ...(process.env.QX_E2E_DOWNLOAD_DIR ? { downloadDirectory: process.env.QX_E2E_DOWNLOAD_DIR } : {}),
      ...(process.env.QX_E2E_DOWNLOAD_URL ? { downloadUrl: process.env.QX_E2E_DOWNLOAD_URL } : {}),
      realDownloads: process.env.QX_E2E_REAL_ARIA2 === "1",
      verifyPush: Boolean(process.env.QX_E2E_PUSH_URL),
      ...(process.env.QX_E2E_PUSH_URL ? { pushUrl: process.env.QX_E2E_PUSH_URL } : {}),
      verifyCast: Boolean(process.env.QX_E2E_CAST_SSDP_PORT),
      verifyWebControl: process.env.QX_E2E_WEB_CONTROL === "1",
      ...(process.env.QX_E2E_WEB_CONTROL === "1" && webControlService?.url
        ? { webControlUrl: webControlService.url }
        : {}),
      ...(process.env.QX_E2E_HLS_MASTER_URL ? { hlsMasterUrl: process.env.QX_E2E_HLS_MASTER_URL } : {}),
      ...(process.env.QX_E2E_HLS_CHILD_URL ? { hlsChildUrl: process.env.QX_E2E_HLS_CHILD_URL } : {}),
      verifySniffer: ISOLATED_SNIFFER_ENABLED,
      ...(ISOLATED_SNIFFER_ENABLED
        ? {
            sniff: async () => {
              if (!isolatedSniffer) throw new Error("Electron isolated sniffer is unavailable");
              return isolatedSniffer.sniff({
                sourceId: "packaged-e2e",
                playbackSessionId: "packaged-e2e-sniffer",
                initialUrl: requiredEnvironment("QX_E2E_SNIFF_URL"),
                allowedOrigins: [new URL(requiredEnvironment("QX_E2E_SNIFF_URL")).origin],
              });
            },
          }
        : {}),
      ...(process.env.QX_E2E_PLAYBACK_CONFIG
        ? { playback: { configJson: process.env.QX_E2E_PLAYBACK_CONFIG } }
        : {}),
    });
    writeE2eResult(result);
    process.exitCode = result.status === "passed" ? 0 : 1;
  } catch (error) {
    writeE2eResult({ status: "failed", reason: "E2E_RUNNER_ERROR", message: errorMessage(error) });
    process.exitCode = 1;
  }
  await closeShell(true);
  app.quit();
}

async function captureE2eWindow(name: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Main window is unavailable for screenshot capture");
  const directory = process.env.QX_E2E_CAPTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const runName = process.env.QX_E2E_FRESH_TRUST === "0" ? "restart" : "first";
  const image = await mainWindow.webContents.capturePage();
  writeFileSync(join(directory, `${runName}-${name}.png`), image.toPNG());
}

function queueWindowStatePersistence(): void {
  clearWindowStateTimer();
  windowStateTimer = setTimeout(() => {
    windowStateTimer = undefined;
    persistWindowStateNow();
  }, 100);
}

function clearWindowStateTimer(): void {
  if (windowStateTimer !== undefined) clearTimeout(windowStateTimer);
  windowStateTimer = undefined;
}

function persistWindowStateNow(): void {
  clearWindowStateTimer();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  const window: Partial<PersistedWindowState> = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    isMaximized: mainWindow.isMaximized(),
  };
  getDesktopStateStore().patch({ window });
}

async function runNetworkTimeoutE2e(baseUrl: string): Promise<void> {
  try {
    const response = await fetch(new URL("/api/import/load", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: requiredEnvironment("QX_E2E_CONFIG_URL") }),
    });
    const value: unknown = await response.json();
    const importState = isRecord(value) && isRecord(value.import) ? value.import : null;
    const error = importState && isRecord(importState.error) ? importState.error : null;
    const errorCode = error && typeof error.code === "string" ? error.code : null;
    const result = {
      status: response.ok && errorCode === "IMPORT_FETCH_ERROR" ? "passed" : "failed",
      errorCode,
    };
    writeE2eResult(result);
    process.exitCode = result.status === "passed" ? 0 : 1;
  } catch (error) {
    writeE2eResult({ status: "failed", reason: "NETWORK_PROBE_ERROR", message: errorMessage(error) });
    process.exitCode = 1;
  }
  await closeShell(true);
  app.quit();
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing Electron E2E environment variable: ${name}`);
  return value;
}

function writeE2eResult(result: PackagedE2eResult | Record<string, unknown>): void {
  const outputPath = process.env.QX_E2E_RESULT_PATH;
  const serialized = JSON.stringify(result, null, 2);
  if (outputPath) writeFileSync(outputPath, `${serialized}\n`, "utf8");
  console.log(`electron-e2e: ${serialized}`);
}

function numberEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function webControlPortEnvironment(): number {
  const value = Number(process.env.QX_WEB_CONTROL_PORT);
  return Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : 0;
}

function listEnvironment(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function castAdvertisedHost(): string {
  const configured = process.env.QX_CAST_ADVERTISED_HOST?.trim();
  if (configured) return configured;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      const family = address.family;
      if (family === "IPv4" && !address.internal && isPrivateIpv4(address.address)) return address.address;
    }
  }
  return "127.0.0.1";
}

function isPrivateIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  if (first === undefined || second === undefined) return false;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254);
}

function playbackFallbackModeEnvironment(name: string): PlaybackFallbackMode {
  const value = process.env[name];
  return value === "off" || value === "auto" || value === "prompt" ? value : "prompt";
}

function parserCandidatesEnvironment(name: string): ParserCandidate[] {
  const raw = process.env[name];
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(isRecord)
      .map((candidate): ParserCandidate | null => {
        const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
        const nameValue = typeof candidate.name === "string" ? candidate.name.trim() : "";
        const type = candidate.type;
        const priority = candidate.priority;
        const timeout = candidate.timeout;
        if (!id || !nameValue
          || !isParserType(type)
          || typeof candidate.enabled !== "boolean"
          || typeof priority !== "number"
          || !Number.isFinite(priority)
          || typeof timeout !== "number"
          || !Number.isFinite(timeout)
          || timeout <= 0) {
          return null;
        }
        const endpoint = typeof candidate.endpoint === "string" && candidate.endpoint.trim()
          ? candidate.endpoint.trim()
          : undefined;
        const headers = isRecord(candidate.headers)
          ? Object.fromEntries(
            Object.entries(candidate.headers)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string")
              .slice(0, 16),
          )
          : undefined;
        return {
          id: id.slice(0, 120),
          name: nameValue.slice(0, 120),
          type,
          ...(endpoint ? { endpoint: endpoint.slice(0, 2048) } : {}),
          ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
          enabled: candidate.enabled,
          priority: Math.floor(priority),
          timeout: Math.floor(timeout),
        };
      })
      .filter((candidate): candidate is ParserCandidate => candidate !== null)
      .slice(0, 16);
  } catch {
    return [];
  }
}

function isParserType(value: unknown): value is ParserCandidate["type"] {
  return value === "direct"
    || value === "json"
    || value === "redirect"
    || value === "html-declared"
    || value === "source-provided"
    || value === "fixture";
}

function playbackRulesEnvironment(name: string): PlaybackRule[] {
  const raw = process.env[name];
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(isRecord)
      .map((rule): PlaybackRule | null => {
        const id = typeof rule.id === "string" ? rule.id.trim() : "";
        const sourceId = typeof rule.sourceId === "string" ? rule.sourceId.trim() : "";
        const safeDescription = typeof rule.safeDescription === "string" ? rule.safeDescription.trim() : "";
        const scope = rule.scope;
        const priority = rule.priority;
        const match = parsePlaybackRuleMatch(rule.match);
        const action = parsePlaybackRuleAction(rule.action);
        if (!id || !sourceId || !safeDescription
          || typeof rule.enabled !== "boolean"
          || typeof priority !== "number"
          || !Number.isFinite(priority)
          || !isPlaybackRuleScope(scope)
          || !match
          || !action) return null;
        return {
          id: id.slice(0, 120),
          sourceId: sourceId.slice(0, 240),
          enabled: rule.enabled,
          priority: Math.floor(priority),
          match,
          action,
          scope,
          safeDescription: safeDescription.slice(0, 240),
        };
      })
      .filter((rule): rule is PlaybackRule => rule !== null)
      .slice(0, 32);
  } catch {
    return [];
  }
}

function parsePlaybackRuleMatch(value: unknown): PlaybackRuleMatch | null {
  if (!isRecord(value)) return null;
  const match: PlaybackRuleMatch = {};
  if (value.origin !== undefined && typeof value.origin !== "string") return null;
  if (value.pathPrefix !== undefined && typeof value.pathPrefix !== "string") return null;
  if (value.extension !== undefined && typeof value.extension !== "string") return null;
  if (value.playbackSessionId !== undefined && typeof value.playbackSessionId !== "string") return null;
  if (value.lineContains !== undefined && typeof value.lineContains !== "string") return null;
  if (typeof value.origin === "string") match.origin = value.origin.slice(0, 2048);
  if (typeof value.pathPrefix === "string") match.pathPrefix = value.pathPrefix.slice(0, 512);
  if (typeof value.extension === "string") match.extension = value.extension.slice(0, 64);
  if (typeof value.playbackSessionId === "string") match.playbackSessionId = value.playbackSessionId.slice(0, 120);
  if (typeof value.lineContains === "string") match.lineContains = value.lineContains.slice(0, 160);
  return match;
}

function parsePlaybackRuleAction(value: unknown): PlaybackRuleAction | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "url-rewrite" || value.type === "path-replace" || value.type === "uri-rewrite") {
    return typeof value.from === "string" && typeof value.to === "string"
      ? { type: value.type, from: value.from.slice(0, 1024), to: value.to.slice(0, 2048) }
      : null;
  }
  if (value.type === "header-merge") {
    if (!isRecord(value.headers)) return null;
    const headers = Object.fromEntries(
      Object.entries(value.headers)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .slice(0, 16),
    );
    return { type: "header-merge", headers };
  }
  if (value.type === "query-parameter") {
    return typeof value.name === "string" && typeof value.value === "string"
      && (value.mode === undefined || value.mode === "set" || value.mode === "append")
      ? { type: "query-parameter", name: value.name.slice(0, 120), value: value.value.slice(0, 512), ...(value.mode ? { mode: value.mode } : {}) }
      : null;
  }
  if (value.type === "host-replace") {
    return typeof value.host === "string"
      && (value.port === undefined || typeof value.port === "number")
      ? { type: "host-replace", host: value.host.slice(0, 255), ...(value.port !== undefined ? { port: Math.floor(value.port) } : {}) }
      : null;
  }
  if (value.type === "line-filter") {
    return typeof value.contains === "string" ? { type: "line-filter", contains: value.contains.slice(0, 160) } : null;
  }
  if (value.type === "marker-filter") {
    return Array.isArray(value.markers)
      ? { type: "marker-filter", markers: value.markers.filter((marker): marker is string => typeof marker === "string").slice(0, 16) }
      : null;
  }
  return null;
}

function isPlaybackRuleScope(value: unknown): value is PlaybackRuleScope {
  return value === "source"
    || value === "playback-session"
    || value === "media-origin"
    || value === "path";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
