import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, dialog, screen, session as electronSession } from "electron";

import { JsonFileTrustPersistence, ImportTrustStore } from "../config/trust.js";
import { ConfigHistoryStore, JsonFileConfigHistoryPersistence } from "../config/history.js";
import { DesktopSpiderImportController } from "../desktop/spider-import.js";
import { DesktopSpiderSession } from "../desktop/spider-session.js";
import { DesktopSpiderUiServer } from "../desktop/spider-ui.js";
import type { ParserCandidate } from "../desktop/parse-chain.js";
import type { PlaybackRule, PlaybackRuleAction, PlaybackRuleMatch, PlaybackRuleScope } from "../desktop/playback-rules.js";
import {
  JsonFileDesktopStateStore,
  restoreWindowBounds,
  type PersistedWindowState,
} from "../desktop/state-persistence.js";
import type { DesktopSpiderClientPort } from "../desktop/spider-client-port.js";
import type { PlaybackFallbackMode } from "../health/playback-health.js";
import { EngineRouter } from "../engine/engine-router.js";
import { readJellyfinEnvironment } from "../jellyfin/jellyfin-adapter.js";
import { resolveJavaExecutable } from "../spikes/java-probe.js";
import {
  runPackagedE2e,
  type PackagedE2eResult,
} from "./e2e-runner.js";
import { runFakeMpvExitProbe } from "./fake-mpv-probe.js";
import { resolveElectronRuntime } from "./runtime.js";
import { DesktopShellRuntime } from "./shell-runtime.js";
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
const ISOLATED_SNIFFER_ENABLED = process.env.QX_SNIFF_ENABLED === "1";

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
let desktopStateStore: JsonFileDesktopStateStore | undefined;
let windowStateTimer: ReturnType<typeof setTimeout> | undefined;

function getDesktopStateStore(): JsonFileDesktopStateStore {
  return desktopStateStore ??= new JsonFileDesktopStateStore(join(app.getPath("userData"), "desktop-state.json"));
}

function createShell(): DesktopShellRuntime {
  const stateStore = getDesktopStateStore();
  const trustStore = new ImportTrustStore(
    new JsonFileTrustPersistence(join(app.getPath("userData"), "trusted-sources.json")),
  );
  const configHistory = new ConfigHistoryStore(
    new JsonFileConfigHistoryPersistence(join(app.getPath("userData"), "config-history.json")),
  );

  return new DesktopShellRuntime({
    resolveRuntime: () => resolveElectronRuntime(
      runtimeDirectory(),
      forceExternalJavaDisabled() ? () => null : resolveJavaExecutable,
      { allowBundledJre: !forceBundledJreDisabled() },
    ),
    createServer: (runtime) => {
      const router = new EngineRouter({ maxActiveSessions: 4, idleSessionMs: 30_000 });
      const jellyfinConfig = readJellyfinEnvironment(process.env);
      engineRouter = router;
      const importer = new DesktopSpiderImportController({
        trustStore,
        history: configHistory,
        autoRefresh: process.env.QX_CONFIG_AUTO_REFRESH === "1",
        refreshIntervalMs: numberEnvironment("QX_CONFIG_REFRESH_INTERVAL_MS", 6 * 60 * 60 * 1000),
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
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
              pythonExecutable: process.env.QX_PYTHON ?? "python",
              ...(jellyfinConfig ? { jellyfinConfig } : {}),
              requestTimeoutMs: REQUEST_TIMEOUT_MS,
              startupTimeoutMs: STARTUP_TIMEOUT_MS,
            });
            lastClient = client;
            return client;
          },
        }),
      });
      const sniffer = ISOLATED_SNIFFER_ENABLED
        ? new IsolatedSniffer(createElectronSnifferPlatform())
        : undefined;
      isolatedSniffer = sniffer;
      const server = new DesktopSpiderUiServer({
        importer,
        rendererDirectory: join(app.getAppPath(), "dist", "renderer"),
        stateStore,
        onPlayerOpen: openPlayerWindow,
        onPlayerAttach: closePlayerWindow,
        onPlayerStop: closePlayerWindow,
        ...(PLAYBACK_PROXY_ORIGINS.length > 0 ? { playbackProxyOrigins: PLAYBACK_PROXY_ORIGINS } : {}),
        ...(PARSER_CANDIDATES.length > 0 ? { parserCandidates: PARSER_CANDIDATES } : {}),
        ...(PARSER_ALLOWED_ORIGINS.length > 0 ? { parserAllowedOrigins: PARSER_ALLOWED_ORIGINS } : {}),
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
  return app.isPackaged
    ? join(process.resourcesPath, "electron-runtime")
    : join(process.cwd(), "dist", "electron-runtime");
}

function forceExternalJavaDisabled(): boolean {
  return process.env.QX_ELECTRON_FORCE_NO_EXTERNAL_JAVA === "1"
    || process.env.QX_ELECTRON_FORCE_NO_JDK === "1";
}

function forceBundledJreDisabled(): boolean {
  return process.env.QX_ELECTRON_FORCE_NO_BUNDLED_JRE === "1";
}

async function closeShell(): Promise<void> {
  if (!cleanupPromise) {
      cleanupPromise = (async () => {
        await closePlayerWindow();
        await shell?.close();
        await engineRouter?.destroyAll();
      })();
  }
  await cleanupPromise;
}

async function openPlayerWindow(): Promise<void> {
  if (!playerWindowUrl) throw new Error("Player window is unavailable before the main window starts");
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.focus();
    return;
  }

  const child = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: !SMOKE_MODE && !E2E_MODE,
    title: `${APP_NAME} · 播放`,
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
    await closeShell();
    app.quit();
    return;
  }
  const uiUrl = started.url;
  playerWindowUrl = uiUrl;
  const persisted = getDesktopStateStore().state;
  const displays = screen.getAllDisplays().map((display) => display.workArea);
  const restoredBounds = restoreWindowBounds(persisted.window, displays, screen.getPrimaryDisplay().workArea);

  mainWindow = new BrowserWindow({
    ...restoredBounds,
    minWidth: 960,
    minHeight: 640,
    show: !SMOKE_MODE && !E2E_MODE,
    title: APP_NAME,
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
  });

  try {
    await mainWindow.loadURL(uiUrl);
  } catch (error) {
    if (E2E_MODE) {
      writeE2eResult({ status: "failed", reason: "UI_LOAD_ERROR", message: errorMessage(error) });
    } else {
      dialog.showErrorBox(APP_NAME, errorMessage(error));
    }
    await closeShell();
    app.quit();
  }
}

app.on("before-quit", (event) => {
  if (quitting || !shell || shell.state.status === "closed") return;
  event.preventDefault();
  quitting = true;
  persistWindowStateNow();
  void closeShell().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  void createMainWindow();
});

void app.whenReady().then(createMainWindow).catch(async (error: unknown) => {
  if (E2E_MODE) {
    writeE2eResult({ status: "failed", reason: "APP_READY_ERROR", message: errorMessage(error) });
  } else {
    dialog.showErrorBox(APP_NAME, errorMessage(error));
  }
  await closeShell();
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
      verifyPlaybackHealth: Boolean(process.env.QX_E2E_PLAYBACK_CONFIG),
      verifyPlaybackFallback: Boolean(process.env.QX_E2E_PLAYBACK_CONFIG),
      verifyParserFallback: Boolean(process.env.QX_E2E_PLAYBACK_CONFIG),
      verifySniffFallback: Boolean(process.env.QX_E2E_PLAYBACK_CONFIG) && ISOLATED_SNIFFER_ENABLED,
      verifyAggregateSearch: true,
      verifyFakeMpv: process.env.QX_E2E_FAKE_MPV === "1",
      ...(process.env.QX_E2E_FAKE_MPV === "1" ? { fakeMpv: runFakeMpvExitProbe } : {}),
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
  await closeShell();
  app.quit();
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
  await closeShell();
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

function listEnvironment(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
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
