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
import type { LiveFailoverMode } from "../live/live-types.js";
import { EngineRouter } from "../engine/engine-router.js";
import { SpiderArtifactCache } from "../spider/spider-artifact-cache.js";
import { NativeSpiderRuntime, SpiderRuntimeManager } from "../spider/spider-runtime.js";
import { AndroidArtifactRegistry, AndroidSpiderBridgeClient } from "../spider/android-spider-bridge-client.js";
import type { AndroidRuntimeStatus as LegacyAndroidRuntimeStatus } from "../spider/android-runtime-diagnostics.js";
import { AndroidRuntimeBootstrapper } from "../spider/android-runtime-bootstrapper.js";
import { AndroidRuntimeSupervisor } from "../spider/android-runtime-supervisor.js";
import { ANDROID_RUNTIME_AVD_NAME, ANDROID_RUNTIME_COMPACT_AVD_NAME, type AndroidRuntimeAvdName } from "../spider/android-runtime-types.js";
import { ElectronSpiderCredentialProvider } from "../spider/electron-spider-credential-provider.js";
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
  LiveRepository,
  EpgRepository,
  SmartChannelRepository,
  PlaybackProgressRepository,
  SettingsRepository,
  HealthRepository,
} from "../data/repositories.js";
import { FavoritesService } from "../favorites/favorites-service.js";
import { HistoryProgressService } from "../history/history-progress.js";
import { FollowService } from "../follow/follow-service.js";
import { CacheService } from "../cache/cache-service.js";
import { LiveSourceService } from "../live/live-service.js";
import { LivePlaybackService } from "../live/live-playback.js";
import { SmartChannelService } from "../live/smart-channels.js";
import { EpgMatchingService } from "../epg/epg-matching-service.js";
import { EpgService } from "../epg/epg-service.js";
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
const LIVE_FAILOVER_MODE = liveFailoverModeEnvironment("QX_LIVE_FAILOVER_MODE");
const LIVE_FAILOVER_MAX_ATTEMPTS = numberEnvironment("QX_LIVE_FAILOVER_MAX_ATTEMPTS", 3);
const LIVE_FAILOVER_TIMEOUT_MS = numberEnvironment("QX_LIVE_FAILOVER_TIMEOUT_MS", 30_000);
const LIVE_FAILOVER_COOLDOWN_MS = numberEnvironment("QX_LIVE_FAILOVER_COOLDOWN_MS", 15_000);
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
let embeddedAndroidRuntimeSupervisor: AndroidRuntimeSupervisor | undefined;
let androidRuntimeConsentPrompt: Promise<boolean> | undefined;
let engineRouter: EngineRouter | undefined;
let dataLayer: SqliteDataLayer | undefined;
let desktopStateStore: DesktopStateStorePort | undefined;
let configHistoryStore: ConfigHistoryStore | undefined;
let historyProgressService: HistoryProgressService | undefined;
let favoritesService: FavoritesService | undefined;
let followService: FollowService | undefined;
let cacheService: CacheService | undefined;
let liveSourceService: LiveSourceService | undefined;
let livePlaybackService: LivePlaybackService | undefined;
let smartChannelService: SmartChannelService | undefined;
let epgService: EpgService | undefined;
let epgMatchingService: EpgMatchingService | undefined;
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
function getLiveSourceService(): LiveSourceService {
  initializeDataLayer();
  if (!liveSourceService) throw new Error("Live source service is unavailable");
  return liveSourceService;
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
  if (dataLayer && desktopStateStore && configHistoryStore && historyProgressService && favoritesService && followService && cacheService && liveSourceService && livePlaybackService && smartChannelService && epgService && epgMatchingService && danmakuService && localMediaService && downloadService && pushService && castService && webSecurity && backupRestoreService) return;
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
  const liveRepository = new LiveRepository(opened.layer);
  const epgRepository = new EpgRepository(opened.layer);
  liveSourceService = new LiveSourceService({
    repository: liveRepository,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  epgService = new EpgService({
    repository: epgRepository,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  epgMatchingService = new EpgMatchingService({
    liveRepository,
    epgRepository,
  });
  smartChannelService = new SmartChannelService({
    repository: new SmartChannelRepository(opened.layer),
    liveRepository,
    epgRepository,
  });
  livePlaybackService = new LivePlaybackService({
    repository: liveRepository,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    healthStore: new HealthRepository(opened.layer),
    failoverMode: LIVE_FAILOVER_MODE,
    failoverMaxAttempts: LIVE_FAILOVER_MAX_ATTEMPTS,
    failoverTimeoutMs: LIVE_FAILOVER_TIMEOUT_MS,
    failoverCooldownMs: LIVE_FAILOVER_COOLDOWN_MS,
    onSelection: (selection) => {
      if (selection.smartChannelId && selection.smartMemberId) {
        smartChannelService?.markActiveMember(selection.smartChannelId, selection.smartMemberId);
      }
      // Smart failover changes the playback member, not the user's EPG
      // identity. Initial/manual Smart selection still establishes the
      // timeline; an automatic member switch leaves that request intact.
      if (selection.reason !== "failover" || !selection.smartChannelId) {
        epgMatchingService?.setTimeline(selection.channelId);
      }
    },
    ...(PLAYBACK_PROXY_ORIGINS.length > 0 ? { proxyAllowedOrigins: PLAYBACK_PROXY_ORIGINS } : {}),
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
      const androidArtifactRegistry = new AndroidArtifactRegistry();
      const androidCredentialProvider = new ElectronSpiderCredentialProvider(
        join(getDataStorageService().directories().settings, "android-uc.credential"),
      );
      const androidPaths = runtimePaths();
      const qxRuntimePaths = androidPaths.getAndroidRuntimePaths();
      let runtimeSupervisorForProgress: AndroidRuntimeSupervisor | undefined;
      const androidRuntimeBootstrapper = new AndroidRuntimeBootstrapper({
        paths: qxRuntimePaths,
        hostApkPath: androidPaths.getAndroidHostApkPath(),
        avdName: androidRuntimeAvdName(),
        javaExecutable: runtime.javaExecutable,
        progressLogger: (progress) => runtimeSupervisorForProgress?.updateProgress(progress),
      });
      const androidRuntimeSupervisor = new AndroidRuntimeSupervisor({
        paths: qxRuntimePaths,
        bootstrapper: androidRuntimeBootstrapper,
        avdName: androidRuntimeAvdName(),
        diagnosticLogger: (event, details) => getRuntimeLogger().info(event, details),
      });
      runtimeSupervisorForProgress = androidRuntimeSupervisor;
      embeddedAndroidRuntimeSupervisor = androidRuntimeSupervisor;
      void androidRuntimeSupervisor.refresh().then((status) => {
        getRuntimeLogger().info("ANDROID_RUNTIME_STATUS", {
          supervisorState: status.supervisorState,
          bootstrapState: status.bootstrapState,
          whpx: status.whpx,
          diagnostics: status.diagnostics,
        });
        if (status.mode === "resident" && status.bootstrapState === "READY") {
          void androidRuntimeSupervisor.ensureReady().catch((error) => getRuntimeLogger().error("ANDROID_RUNTIME_RESIDENT_START_FAILED", error));
        }
      }).catch((error) => {
        getRuntimeLogger().error("ANDROID_RUNTIME_STATUS", error);
      });
      let nextAndroidLocalPort = 8766;
      const createRuntimeManager = (config: TvBoxConfig, sourceUrl?: string) => {
        return new SpiderRuntimeManager({
        config,
        ...(sourceUrl ? { sourceUrl } : {}),
          artifactCache: new SpiderArtifactCache(qxRuntimePaths.spiderCachePath ?? join(getDataStorageService().directories().dataRoot, "spider-cache"), {
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
        pythonExecutable: runtime.pythonExecutable ?? (app.isPackaged ? "" : process.env.QX_PYTHON ?? "python"),
        spiderCredentialProvider: androidCredentialProvider,
        androidRuntimePreparer: async () => {
          await ensureAndroidRuntimeForSite(androidRuntimeSupervisor);
        },
        androidBridgeClientFactory: async (site, support) => {
          if (!support.artifactPath) return undefined;
          await ensureAndroidRuntimeForSite(androidRuntimeSupervisor);
          return new AndroidSpiderBridgeClient({
            deviceManager: androidRuntimeSupervisor.deviceManager,
            localPort: nextAndroidLocalPort++,
            requestTimeoutMs: 30_000,
            healthTimeoutMs: 10_000,
            operationTimeoutMs: 180_000,
            ...(site.key ?? site.api ? { siteKey: site.key ?? site.api } : {}),
            ...(site.name ? { sourceName: site.name } : {}),
            ...(support.artifactUrl ? { artifactUrl: support.artifactUrl } : {}),
            artifactRegistry: androidArtifactRegistry,
          });
        },
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
        androidCredentials: androidCredentialProvider,
        androidRuntimeStatus: () => embeddedAndroidStatus(androidRuntimeSupervisor, androidPaths.getAndroidHostApkPath()),
        androidRuntimeActions: {
          ensure: (confirmed) => androidRuntimeSupervisor.ensureReady({ consent: confirmed }),
          enableWhpx: (confirmed) => androidRuntimeSupervisor.enableWhpx(confirmed),
          setMode: (mode) => androidRuntimeSupervisor.setMode(mode),
          restart: () => androidRuntimeSupervisor.restart(),
          repair: (confirmed) => androidRuntimeSupervisor.repair(confirmed),
          reinstall: (confirmed) => androidRuntimeSupervisor.reinstall(confirmed),
          cancel: () => androidRuntimeSupervisor.cancelProvision(),
          uninstall: () => androidRuntimeSupervisor.uninstall(),
          stop: () => androidRuntimeSupervisor.stopRuntime(),
        },
        danmaku: getDanmakuService(),
        localMedia: getLocalMediaService(),
        ...(downloadService ? { downloads: downloadService } : {}),
        ...(pushService ? { push: pushService } : {}),
        ...(castService ? { cast: castService } : {}),
        live: getLiveSourceService(),
        ...(livePlaybackService ? { livePlayback: livePlaybackService } : {}),
        ...(smartChannelService ? { smartChannels: smartChannelService } : {}),
        ...(epgService ? { epg: epgService } : {}),
        ...(epgMatchingService ? { epgMatching: epgMatchingService } : {}),
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

function embeddedAndroidStatus(
  supervisor: AndroidRuntimeSupervisor,
  hostApkPath: string,
): LegacyAndroidRuntimeStatus {
  const status = supervisor.status();
  const qx = runtimePaths().getQxRuntimePaths();
  return {
    adbFound: status.adbFound,
    deviceFound: status.deviceFound,
    deviceStatus: status.deviceFound ? "online" : "missing",
    hostApkFound: existsSync(hostApkPath),
    hostApkPath,
    hostInstalled: status.hostInstalled,
    hostStatus: status.hostOnline ? "online" : status.hostInstalled ? "offline" : "missing",
    androidHostOnline: status.hostOnline,
    diagnostics: status.diagnostics,
    message: status.message,
    bootstrapState: status.bootstrapState,
    supervisorState: status.supervisorState,
    consentRequired: status.consentRequired,
    runtimeVersion: status.runtimeVersion,
    ...(status.hostVersion ? { hostVersion: status.hostVersion } : {}),
    androidApi: status.androidApi,
    architecture: status.architecture,
    avdName: status.avdName,
    estimatedDownload: status.estimatedDownload,
    ...(status.diskUsageBytes !== undefined ? { diskUsageBytes: status.diskUsageBytes } : {}),
    mode: status.mode,
    whpx: status.whpx,
    progress: status.progress,
    runtimeRoot: qx.runtimeRoot,
    sdkRoot: qx.sdkRoot,
    adbPath: qx.adbPath,
    emulatorPath: qx.emulatorPath,
    avdHome: qx.avdHome,
    androidUserHome: qx.androidUserHome,
  };
}

async function ensureAndroidRuntimeForSite(supervisor: AndroidRuntimeSupervisor): Promise<void> {
  const e2eConsent = process.env.QX_ANDROID_E2E_CONSENT === "1";
  getRuntimeLogger().info("ANDROID_RUNTIME_PREPARE_START", {
    e2eConsent,
    supervisorState: supervisor.status().supervisorState,
    bootstrapState: supervisor.status().bootstrapState,
  });
  try {
    await supervisor.ensureReady({ consent: e2eConsent });
    getRuntimeLogger().info("ANDROID_RUNTIME_PREPARE_READY", {
      supervisorState: supervisor.status().supervisorState,
      bootstrapState: supervisor.status().bootstrapState,
      hostOnline: supervisor.status().hostOnline,
    });
    return;
  } catch (error) {
    getRuntimeLogger().error("ANDROID_RUNTIME_PREPARE_FAILED", error, {
      supervisorState: supervisor.status().supervisorState,
      bootstrapState: supervisor.status().bootstrapState,
      diagnostics: supervisor.status().diagnostics,
    });
    if (e2eConsent || !supervisor.status().consentRequired) throw error;
  }
  if (!androidRuntimeConsentPrompt) {
    const status = supervisor.status();
    const options = {
      type: "info" as const,
      title: "Android 兼容运行环境",
      message: "当前 Android DEX 来源需要安装独立的 Android 兼容运行环境。",
      detail: `预计下载 ${status.estimatedDownload}，组件来自 Android 官方源；继续即表示你确认阅读并接受所需 Android SDK 许可协议。`,
      buttons: ["取消", "安装并继续"],
      defaultId: 1,
      cancelId: 0,
    };
    androidRuntimeConsentPrompt = (mainWindow
      ? dialog.showMessageBox(mainWindow, options)
      : dialog.showMessageBox(options))
      .then((result) => result.response === 1)
      .finally(() => { androidRuntimeConsentPrompt = undefined; });
  }
  if (!await androidRuntimeConsentPrompt) throw new Error("ANDROID_RUNTIME_CONSENT_REQUIRED");
  await supervisor.ensureReady({ consent: true });
}

function runtimePaths(): RuntimePathResolver {
  return new RuntimePathResolver({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    ...(process.env.LOCALAPPDATA ? { localAppDataPath: process.env.LOCALAPPDATA } : {}),
    ...(process.env.QX_ANDROID_RUNTIME_ROOT?.trim() ? { androidRuntimeRoot: process.env.QX_ANDROID_RUNTIME_ROOT.trim() } : {}),
    isPackaged: app.isPackaged,
  });
}

function androidRuntimeAvdName(): AndroidRuntimeAvdName {
  return process.env.QX_ANDROID_AVD_NAME === ANDROID_RUNTIME_COMPACT_AVD_NAME
    ? ANDROID_RUNTIME_COMPACT_AVD_NAME
    : ANDROID_RUNTIME_AVD_NAME;
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
        await embeddedAndroidRuntimeSupervisor?.stopRuntime().catch(() => undefined);
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
  await livePlaybackService?.close();
  epgService?.close();
  epgMatchingService?.close();
  danmakuService?.close();
  historyProgressService?.appClose();
  historyProgressService = undefined;
  favoritesService = undefined;
  followService = undefined;
  cacheService = undefined;
  liveSourceService = undefined;
  livePlaybackService = undefined;
  smartChannelService = undefined;
  epgService = undefined;
  epgMatchingService = undefined;
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
    minWidth: 960,
    minHeight: 640,
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
  if (process.env.QX_ANDROID_PACKAGED_PLAYBACK === "1") {
    await runAndroidPackagedPlayback();
  }
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
      verifyLiveSources: Boolean(process.env.QX_E2E_LIVE_URL),
      ...(process.env.QX_E2E_LIVE_URL ? { liveUrl: process.env.QX_E2E_LIVE_URL } : {}),
      verifyLivePlayback: Boolean(process.env.QX_E2E_LIVE_PLAYBACK_URL),
      ...(process.env.QX_E2E_LIVE_PLAYBACK_URL ? { livePlaybackUrl: process.env.QX_E2E_LIVE_PLAYBACK_URL } : {}),
      verifyLiveFailover: Boolean(process.env.QX_E2E_LIVE_FAILOVER_URL),
      ...(process.env.QX_E2E_LIVE_FAILOVER_URL ? { liveFailoverUrl: process.env.QX_E2E_LIVE_FAILOVER_URL } : {}),
      ...(process.env.QX_E2E_LIVE_FAILOVER_BACKUP_URL ? { liveFailoverBackupUrl: process.env.QX_E2E_LIVE_FAILOVER_BACKUP_URL } : {}),
      ...(process.env.QX_E2E_LIVE_FAILOVER_BROKEN_URL ? { liveFailoverBrokenUrl: process.env.QX_E2E_LIVE_FAILOVER_BROKEN_URL } : {}),
      verifySmartChannels: Boolean(process.env.QX_E2E_LIVE_SMART_URL),
      ...(process.env.QX_E2E_LIVE_SMART_URL ? { smartBackupUrl: process.env.QX_E2E_LIVE_SMART_URL } : {}),
      verifyEpg: Boolean(process.env.QX_E2E_EPG_URL),
      ...(process.env.QX_E2E_EPG_URL ? { epgUrl: process.env.QX_E2E_EPG_URL } : {}),
      verifyEpgMatching: Boolean(process.env.QX_E2E_EPG_URL && process.env.QX_E2E_LIVE_PLAYBACK_URL),
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

async function runAndroidPackagedPlayback(): Promise<void> {
  const baseUrl = uiServer?.url;
  const configUrl = process.env.QX_ANDROID_E2E_CONFIG_URL?.trim();
  const keyword = process.env.QX_ANDROID_E2E_KEYWORD?.trim() || "庆余年";
  if (!baseUrl || !configUrl) throw new Error("ANDROID_PACKAGED_PLAYBACK_CONFIG_MISSING");
  try {
    const imported = await postJson(new URL("/api/import/load", baseUrl), { input: configUrl });
    const importState = recordValue(imported.import);
    const doubanSite = Array.isArray(importState?.sites)
      ? importState.sites.map(recordValue).find((site) => site?.api === "csp_Douban")
      : null;
    const jianpianSite = Array.isArray(importState?.sites)
      ? importState.sites.map(recordValue).find((site) => site?.api === "csp_Jianpian")
      : null;
    if (typeof doubanSite?.key !== "string" || !doubanSite.key) {
      throw new Error(`ANDROID_PACKAGED_PLAYBACK_DOUBAN_MISSING: ${JSON.stringify(imported.import ?? null)}`);
    }
    if (typeof jianpianSite?.key !== "string" || !jianpianSite.key) {
      throw new Error(`ANDROID_PACKAGED_PLAYBACK_JIANPIAN_MISSING: ${JSON.stringify(imported.import ?? null)}`);
    }
    const selected = await postJson(new URL("/api/import/select", baseUrl), { siteKey: doubanSite.key });
    assertAndroidImportState(selected, "select", importState?.status === "confirmation_required");
    if (importState?.status === "confirmation_required") {
      const confirmed = await postJson(new URL("/api/import/confirm", baseUrl), {});
      assertAndroidImportState(confirmed, "confirm");
    }
    // Start the dedicated Runtime before opening the source.  This keeps the
    // first clean-machine Provision outside any Spider/open request timeout.
    // The packaged runner already owns this Supervisor, so waiting on it
    // directly avoids the 300s response-header timeout of a long local HTTP
    // request while official SDK components are being downloaded.
    if (!embeddedAndroidRuntimeSupervisor) throw new Error("ANDROID_PACKAGED_PLAYBACK_RUNTIME_UNAVAILABLE");
    await embeddedAndroidRuntimeSupervisor.ensureReady({ consent: true });
    const opened = await postJson(new URL("/api/open", baseUrl), {});
    const openedState = recordValue(opened.state);
    const openedError = recordValue(openedState?.error);
    if (openedState?.status === "error" || openedError) {
      const code = typeof openedError?.code === "string" ? openedError.code : "SPIDER_OPEN_FAILED";
      const message = typeof openedError?.message === "string"
        ? openedError.message.replace(/https?:\/\/\S+/giu, "[redacted-url]")
        : "";
      throw new Error(`ANDROID_PACKAGED_PLAYBACK_OPEN_${code}${message ? `: ${message}` : ""}`);
    }
    await postJson(new URL("/api/player/fallback/mode", baseUrl), { mode: "off" });
    const searchedResponse = await postJson(new URL("/api/search", baseUrl), {
      key: keyword,
      page: 1,
      quick: false,
      aggregate: false,
    });
    const searched = recordValue(searchedResponse.state);
    assertAndroidPlaybackState(searched, "search");
    const items = Array.isArray(searched?.items) ? searched.items : [];
    const normalizedKeyword = keyword.replace(/[\s\u200B]+/gu, "").toLocaleLowerCase();
    const first = items
      .map(recordValue)
      .find((item) => typeof item?.vod_name === "string"
        && item.vod_name.replace(/[\s\u200B]+/gu, "").toLocaleLowerCase() === normalizedKeyword)
      ?? recordValue(items[0]);
    const vodId = typeof first?.vod_id === "string" ? first.vod_id : typeof first?.id === "string" ? first.id : "";
    if (!vodId) throw new Error("ANDROID_PACKAGED_PLAYBACK_SEARCH_EMPTY");
    const detailResponse = await postJson(new URL("/api/detail", baseUrl), { vodId });
    const detailState = recordValue(detailResponse.state);
    assertAndroidPlaybackState(detailState, "detail");
    if (!recordValue(detailState?.detail)) throw new Error("ANDROID_PACKAGED_PLAYBACK_DETAIL_EMPTY");
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error("ANDROID_PACKAGED_PLAYBACK_WINDOW_MISSING");
    await mainWindow.loadURL(baseUrl);
    const beforeUi = await waitForMainWindowUi("detail", `() => ({
      url: location.href,
      rendererReady: document.querySelector('#vue-renderer')?.getAttribute('data-ready') === 'true',
      rendererPending: document.querySelector('#vue-renderer')?.getAttribute('data-pending') || '',
      status: document.querySelector('[data-testid="status"]')?.textContent || '',
      hasDetail: Boolean(document.querySelector('[data-testid="detail-panel"]')),
      hasFindButton: Boolean(document.querySelector('[data-action="find-playback-source"]')),
    })`, "value => value.rendererReady && value.rendererPending === '' && value.hasDetail && value.hasFindButton");
    await clickMainWindowAndWaitForUi("find-playback-source", `(() => {
      const element = document.querySelector('[data-action="find-playback-source"]');
      if (!(element instanceof HTMLElement)) throw new Error('UI_ELEMENT_MISSING');
      if (element instanceof HTMLButtonElement && element.disabled) throw new Error('UI_ELEMENT_DISABLED');
      element.click();
    })()`, `() => ({
      rendererPending: document.querySelector('#vue-renderer')?.getAttribute('data-pending') || '',
      runtimeReady: Boolean(document.querySelector('[data-testid="android-runtime-ready"]')),
      candidateTexts: [...document.querySelectorAll('[data-action="playback-source-select"]')]
        .map((button) => button.textContent || ''),
      diagnostics: document.querySelector('[data-testid="playback-source-diagnostics"]')?.textContent || '',
      pending: document.querySelector('[data-testid="playback-source-searching"]')?.textContent || '',
    })`, "value => value.runtimeReady && value.candidateTexts.length > 0", 180_000);
    const sourceUi = recordValue(await mainWindow.webContents.executeJavaScript(`(() => ({
      runtimeReady: Boolean(document.querySelector('[data-testid="android-runtime-ready"]')),
      candidateTexts: [...document.querySelectorAll('[data-action="playback-source-select"]')]
        .map((button) => button.textContent || ''),
      diagnostics: document.querySelector('[data-testid="playback-source-diagnostics"]')?.textContent || '',
    }))()`));
    const candidateTexts = Array.isArray(sourceUi?.candidateTexts)
      ? sourceUi.candidateTexts.filter((value): value is string => typeof value === "string")
      : [];
    if (sourceUi?.runtimeReady !== true) throw new Error("ANDROID_PACKAGED_PLAYBACK_RUNTIME_NOT_READY_IN_UI");
    if (!candidateTexts.some((value) => value.includes(String(jianpianSite.key)))) {
      const currentDetail = recordValue(detailState?.detail);
      throw new Error(`ANDROID_PACKAGED_PLAYBACK_JIANPIAN_CANDIDATE_MISSING: ${JSON.stringify({
        title: currentDetail?.vod_name ?? null,
        year: currentDetail?.vod_year ?? null,
        class: currentDetail?.vod_class ?? null,
        candidateTexts,
      })}`);
    }
    await clickMainWindowAndWaitForUi(`jianpian-candidate:${jianpianSite.key}`, `(() => {
      const button = [...document.querySelectorAll('[data-action="playback-source-select"]')]
        .find((candidate) => candidate.getAttribute('data-site-key') === ${JSON.stringify(jianpianSite.key)});
      if (!(button instanceof HTMLElement)) throw new Error('JIANPIAN_CANDIDATE_BUTTON_MISSING');
      button.click();
    })()`, `() => ({
      episodeCount: document.querySelectorAll('[data-action="player-episode"]').length,
      error: document.querySelector('[data-testid="error"]')?.textContent || '',
      detail: Boolean(document.querySelector('[data-testid="detail-panel"]')),
    })`, "value => value.episodeCount > 0 && !value.error && value.detail");
    const playbackCatalog = recordValue(await mainWindow.webContents.executeJavaScript(`(() => ({
      episodeCount: document.querySelectorAll('[data-action="player-episode"]').length,
      error: document.querySelector('[data-testid="error"]')?.textContent || '',
    }))()`));
    if (typeof playbackCatalog?.episodeCount !== "number" || playbackCatalog.episodeCount < 1) {
      throw new Error("ANDROID_PACKAGED_PLAYBACK_JIANPIAN_DETAIL_UNPLAYABLE");
    }
    await clickMainWindowAndWaitForUi("player-episode", `(() => {
      const element = document.querySelector('[data-action="player-episode"]');
      if (!(element instanceof HTMLElement)) throw new Error('PLAYER_EPISODE_BUTTON_MISSING');
      element.click();
    })()`, `() => ({
      hasVideo: Boolean(document.querySelector('video')),
      hasPlayerPanel: Boolean(document.querySelector('[data-testid="embedded-player-panel"]')),
      error: document.querySelector('[data-testid="error"]')?.textContent || '',
    })`, "value => value.hasVideo && value.hasPlayerPanel && !value.error");
    const playerState = recordValue(await mainWindow.webContents.executeJavaScript(`(() => ({
      status: document.querySelector('[data-testid="player-status"]')?.textContent || '',
      error: document.querySelector('[data-testid="error"]')?.textContent || '',
    }))()`));
    if (playerState?.error) throw new Error("ANDROID_PACKAGED_PLAYBACK_PLAYER_CONTENT_FAILED");
    const probe = await mainWindow.webContents.executeJavaScript(`(() => new Promise((resolve) => {
      const started = Date.now();
      const fatalErrors = [];
      const waitForVideo = () => {
        const video = document.querySelector('video');
        if (!video) {
          if (Date.now() - started > 45_000) {
            resolve({ status: 'FAIL', reason: 'VIDEO_ELEMENT_MISSING', fatalErrors });
            return;
          }
          window.setTimeout(waitForVideo, 100);
          return;
        }
        video.addEventListener('error', () => fatalErrors.push('MEDIA_ERROR'), { once: false });
        const requestPlay = () => {
          const button = document.querySelector('[data-action="player-play"]');
          if (button instanceof HTMLElement) button.click();
          else void video.play().catch(() => undefined);
        };
        window.setTimeout(requestPlay, 1_000);
        window.setTimeout(requestPlay, 4_000);
        const describeVideo = () => ({
          hlsState: (() => {
            const instance = document.querySelector('[data-testid="embedded-player-panel"]')?.__qxHlsInstance;
            if (!instance) return null;
            return {
              mediaAttached: instance.media === video,
              hasMediaSource: Boolean(instance.mediaSource),
              levelCount: Array.isArray(instance.levels) ? instance.levels.length : null,
              currentLevel: typeof instance.currentLevel === 'number' ? instance.currentLevel : null,
              urlPresent: typeof instance.url === 'string' && instance.url.length > 0,
            };
          })(),
          currentSrc: video.currentSrc || null,
          src: video.getAttribute('src') || null,
          readyState: video.readyState,
          networkState: video.networkState,
          paused: video.paused,
          errorCode: video.error?.code ?? null,
          errorMessage: video.error?.message ?? null,
          hlsAvailable: Boolean(window.Hls),
          hlsSupported: typeof window.Hls?.isSupported === 'function' ? window.Hls.isSupported() : null,
          mediaSourceSupported: typeof window.MediaSource !== 'undefined',
          hlsError: document.querySelector('[data-testid="embedded-player-panel"]')?.getAttribute('data-hls-error') || null,
          hlsStage: document.querySelector('[data-testid="embedded-player-panel"]')?.getAttribute('data-hls-stage') || null,
          playerMode: document.querySelector('[data-testid="embedded-player-panel"]')?.getAttribute('data-player-mode') || null,
          playerStatus: document.querySelector('[data-testid="embedded-player-panel"]')?.getAttribute('data-player-status') || null,
          playButtonCount: document.querySelectorAll('[data-action="player-play"]').length,
          buffered: Array.from({ length: video.buffered.length }, (_, index) => [video.buffered.start(index), video.buffered.end(index)]),
          proxyResources: performance.getEntriesByType('resource')
            .map((entry) => ({
              name: entry.name,
              responseStatus: entry.responseStatus ?? null,
              transferSize: entry.transferSize ?? null,
              duration: Math.round(entry.duration),
            }))
            .filter((entry) => entry.name.includes('/__qx_playback/'))
            .map((entry) => {
              const marker = '/__qx_playback/';
              const index = entry.name.indexOf(marker);
              return index >= 0 ? { ...entry, name: entry.name.slice(0, index) + marker + '[redacted]' } : entry;
            })
            .slice(-8),
        });
        const inspectProxy = async () => {
          const currentUrl = video.currentSrc || video.getAttribute('src') || '';
          const proxyResourceUrls = performance.getEntriesByType('resource')
            .map((entry) => entry.name)
            .filter((name) => name.includes('/__qx_playback/'));
          const url = currentUrl.includes('/__qx_playback/')
            ? currentUrl
            : proxyResourceUrls.find((name) => /\.m3u8(?:$|[?#])/i.test(name))
              ?? proxyResourceUrls[0]
              ?? currentUrl;
          if (!url.includes('/__qx_playback/')) return { status: null, contentType: null, bodySize: 0, playlistHead: '', error: 'PROXY_URL_MISSING' };
          try {
            const response = await fetch(url, { cache: 'no-store' });
            const body = await response.text();
            const playlistLines = body.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
            const keyLine = playlistLines.find((line) => line.startsWith('#EXT-X-KEY:')) || '';
            const keyMatch = /URI="([^"]+)"/.exec(keyLine);
            const segmentUrl = playlistLines.find((line) => !line.startsWith('#')) || '';
            const probeResource = async (resourceUrl, kind) => {
              if (!resourceUrl) return { kind, status: null, contentType: null, bodySize: 0, firstBytes: '', error: 'RESOURCE_MISSING' };
              try {
                const resource = await fetch(new URL(resourceUrl, url), { cache: 'no-store' });
                const bytes = new Uint8Array(await resource.arrayBuffer());
                return {
                  kind,
                  status: resource.status,
                  contentType: resource.headers.get('content-type'),
                  bodySize: bytes.byteLength,
                  firstBytes: Array.from(bytes.slice(0, 8)).map((value) => value.toString(16).padStart(2, '0')).join(''),
                  error: null,
                };
              } catch (error) {
                return { kind, status: null, contentType: null, bodySize: 0, firstBytes: '', error: String(error) };
              }
            };
            let decryptProbe = { firstBytes: '', error: 'DECRYPT_NOT_ATTEMPTED' };
            if (keyMatch?.[1] && segmentUrl) {
              try {
                const keyResponse = await fetch(new URL(keyMatch[1], url), { cache: 'no-store' });
                const segmentResponse = await fetch(new URL(segmentUrl, url), { cache: 'no-store' });
                const keyBytes = new Uint8Array(await keyResponse.arrayBuffer());
                const segmentBytes = new Uint8Array(await segmentResponse.arrayBuffer());
                const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
                const ivMatch = /IV=0x([0-9a-f]+)\\b/i.exec(keyLine);
                const iv = new Uint8Array(16);
                if (ivMatch?.[1]) {
                  const value = ivMatch[1].padStart(32, '0').slice(-32);
                  for (let index = 0; index < 16; index += 1) iv[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
                }
                const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, segmentBytes));
                const streamTypes = [];
                let pmtPid = null;
                for (let offset = 0; offset + 188 <= decrypted.length; offset += 188) {
                  if (decrypted[offset] !== 0x47) continue;
                  const pid = ((decrypted[offset + 1] & 0x1f) << 8) | decrypted[offset + 2];
                  const payload = (decrypted[offset + 3] >> 4) & 3;
                  let cursor = offset + 4;
                  if (payload === 2 || payload === 3) cursor += 1 + decrypted[cursor];
                  if (cursor >= offset + 188 || (decrypted[offset + 1] & 0x40) === 0) continue;
                  const table = cursor + 1 + decrypted[cursor];
                  if (pid === 0 && decrypted[table] === 0x00) {
                    const programEnd = table + 3 + (((decrypted[table + 1] & 0x0f) << 8) | decrypted[table + 2]);
                    for (let index = table + 8; index + 4 < programEnd; index += 4) {
                      if (decrypted[index] !== 0 || decrypted[index + 1] !== 0) pmtPid = ((decrypted[index + 2] & 0x1f) << 8) | decrypted[index + 3];
                      break;
                    }
                  } else if (pmtPid !== null && pid === pmtPid && decrypted[table] === 0x02) {
                    const sectionEnd = table + 3 + (((decrypted[table + 1] & 0x0f) << 8) | decrypted[table + 2]) - 4;
                    const programInfoLength = ((decrypted[table + 10] & 0x0f) << 8) | decrypted[table + 11];
                    for (let index = table + 12 + programInfoLength; index + 4 < sectionEnd;) {
                      streamTypes.push(decrypted[index].toString(16).padStart(2, '0'));
                      const esInfoLength = ((decrypted[index + 3] & 0x0f) << 8) | decrypted[index + 4];
                      index += 5 + esInfoLength;
                    }
                    break;
                  }
                }
                decryptProbe = { firstBytes: Array.from(decrypted.slice(0, 8)).map((value) => value.toString(16).padStart(2, '0')).join(''), streamTypes, error: '' };
              } catch (error) {
                decryptProbe = { firstBytes: '', streamTypes: [], error: String(error) };
              }
            }
            return {
              status: response.status,
              contentType: response.headers.get('content-type'),
              bodySize: body.length,
              playlistHead: body.slice(0, 512).replace(/https?:\\/\\/[^\\s"']+/g, '[url-redacted]'),
              resources: [
                await probeResource(keyMatch?.[1] || '', 'key'),
                await probeResource(segmentUrl, 'segment'),
              ],
              decryptProbe,
              error: null,
            };
          } catch (error) {
            return { status: null, contentType: null, bodySize: 0, playlistHead: '', resources: [], error: String(error) };
          }
        };
        const finish = async (value) => resolve({ ...value, video: describeVideo(), proxy: await inspectProxy() });
        const waitForPlaying = () => {
          if (video.error) fatalErrors.push('MEDIA_ERROR');
          if (video.videoWidth > 0 && video.videoHeight > 0 && !video.error
            && !video.paused && video.readyState >= 2) {
            const initialTime = video.currentTime;
            const until = Date.now() + 35_000;
            const sample = () => {
              if (video.error) {
                void finish({ status: 'FAIL', reason: 'FATAL_MEDIA_ERROR', videoWidth: video.videoWidth, videoHeight: video.videoHeight, currentTimeStart: initialTime, currentTimeEnd: video.currentTime, fatalErrors });
                return;
              }
              if (video.currentTime >= initialTime + 20) {
                void finish({ status: 'PLAYING', videoWidth: video.videoWidth, videoHeight: video.videoHeight, currentTimeStart: initialTime, currentTimeEnd: video.currentTime, fatalErrors });
                return;
              }
              if (Date.now() >= until) {
                void finish({ status: video.currentTime > initialTime + 20 ? 'PLAYING' : 'FAIL', videoWidth: video.videoWidth, videoHeight: video.videoHeight, currentTimeStart: initialTime, currentTimeEnd: video.currentTime, fatalErrors });
                return;
              }
              window.setTimeout(sample, 500);
            };
            sample();
            return;
          }
          if (Date.now() - started > 45_000) {
            void finish({ status: 'FAIL', reason: 'VIDEO_DID_NOT_REACH_PLAYING', videoWidth: video.videoWidth, videoHeight: video.videoHeight, currentTime: video.currentTime, fatalErrors });
            return;
          }
          window.setTimeout(waitForPlaying, 250);
        };
        waitForPlaying();
      };
      waitForVideo();
    }))()`);
    const result = {
      status: probeValue(probe)?.status === "PLAYING" ? "PASS" : "FAIL",
      source: jianpianSite.api,
      keyword,
      search: "PASS",
      detail: "PASS",
      playerContent: "PASS",
      localMediaProxy: "PASS",
      hlsJs: "PASS",
      probe,
    };
    writeE2eResult(result);
    process.exitCode = result.status === "PASS" ? 0 : 1;
  } catch (error) {
    writeE2eResult({ status: "FAIL", reason: "ANDROID_PACKAGED_PLAYBACK_ERROR", message: errorMessage(error) });
    process.exitCode = 1;
  }
  await closeShell(true);
  app.quit();
}

async function waitForMainWindowUi(
  label: string,
  snapshotScript: string,
  predicateScript: string,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("ANDROID_PACKAGED_PLAYBACK_WINDOW_MISSING");
  const value = recordValue(await mainWindow.webContents.executeJavaScript(`(() => new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      let value;
      try {
        value = (${snapshotScript})();
      } catch (error) {
        value = { error: String(error) };
      }
      let matched = false;
      try {
        matched = (${predicateScript})(value) === true;
      } catch {
        matched = false;
      }
      if (matched || Date.now() - started >= ${timeoutMs}) {
        resolve({ ...value, timedOut: !matched });
        return;
      }
      window.setTimeout(poll, 100);
    };
    poll();
  }))()`));
  if (value?.timedOut === true) {
    throw new Error(`ANDROID_PACKAGED_PLAYBACK_UI_WAIT_TIMEOUT: ${label}: ${JSON.stringify(value)}`);
  }
  return value ?? {};
}

async function clickMainWindowAndWaitForUi(
  label: string,
  actionScript: string,
  snapshotScript: string,
  predicateScript: string,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("ANDROID_PACKAGED_PLAYBACK_WINDOW_MISSING");
  const execution = recordValue(await mainWindow.webContents.executeJavaScript(`(() => {
    try {
      ${actionScript};
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`));
  if (execution?.ok !== true) {
    throw new Error(`ANDROID_PACKAGED_PLAYBACK_UI_ACTION_FAILED: ${label}: ${String(execution?.error ?? "unknown")}`);
  }
  const afterAction = recordValue(await mainWindow.webContents.executeJavaScript(`(() => ({
    rendererPending: document.querySelector('#vue-renderer')?.getAttribute('data-pending') || '',
    searching: Boolean(document.querySelector('[data-testid="playback-source-searching"]')),
    hasSourceCandidates: Boolean(document.querySelector('[data-testid="playback-source-candidates"]')),
  }))()`));
  getPlaybackLogger().info("ANDROID_PACKAGED_PLAYBACK_UI_ACTION", { label, afterAction });
  return waitForMainWindowUi(label, snapshotScript, predicateScript, timeoutMs);
}

async function postJson(url: URL, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    getPlaybackLogger().error("ANDROID_PACKAGED_PLAYBACK_HTTP_FETCH_FAILED", error, { path: url.pathname });
    throw new Error(`ANDROID_PACKAGED_PLAYBACK_HTTP_FETCH_FAILED_${url.pathname}: ${errorMessage(error)}`);
  }
  const value = await response.json() as unknown;
  if (!response.ok) {
    const state = recordValue(value);
    const nestedError = recordValue(recordValue(state?.state)?.error);
    const code = typeof state?.errorCode === "string"
      ? state.errorCode
      : typeof nestedError?.code === "string"
        ? nestedError.code
        : "UNKNOWN";
    const message = typeof state?.error === "string"
      ? state.error
      : typeof nestedError?.message === "string"
        ? nestedError.message
        : "";
    throw new Error(`ANDROID_PACKAGED_PLAYBACK_HTTP_${response.status}_${url.pathname}_${code}${message ? `: ${message}` : ""}`);
  }
  return recordValue(value) ?? {};
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function probeValue(value: unknown): { status?: string } | null {
  return recordValue(value) as { status?: string } | null;
}

function assertAndroidImportState(value: Record<string, unknown>, operation: string, allowConfirmation = false): void {
  const state = recordValue(value.import);
  const error = recordValue(state?.error);
  if ((!allowConfirmation && state?.status !== "ready") || (allowConfirmation && state?.status !== "confirmation_required" && state?.status !== "ready") || error) {
    const code = typeof error?.code === "string" ? error.code : "IMPORT_NOT_READY";
    throw new Error(`ANDROID_PACKAGED_PLAYBACK_IMPORT_${operation}_${code}`);
  }
}

function assertAndroidPlaybackState(state: Record<string, unknown> | null, operation: string): void {
  const error = recordValue(state?.error);
  if (state?.status === "error" || error) {
    const code = typeof error?.code === "string" ? error.code : "STATE_ERROR";
    const message = typeof error?.message === "string"
      ? error.message.replace(/https?:\/\/\S+/giu, "[redacted-url]")
      : "";
    throw new Error(`ANDROID_PACKAGED_PLAYBACK_${operation.toUpperCase()}_${code}${message ? `: ${message}` : ""}`);
  }
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

function liveFailoverModeEnvironment(name: string): LiveFailoverMode {
  const value = process.env[name];
  return value === "off" || value === "auto" || value === "ask" ? value : "ask";
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
