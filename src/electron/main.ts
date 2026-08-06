import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, dialog, screen } from "electron";

import { JsonFileTrustPersistence, ImportTrustStore } from "../config/trust.js";
import { DesktopSpiderImportController } from "../desktop/spider-import.js";
import { DesktopSpiderSession } from "../desktop/spider-session.js";
import { DesktopSpiderUiServer } from "../desktop/spider-ui.js";
import {
  JsonFileDesktopStateStore,
  restoreWindowBounds,
  type PersistedWindowState,
} from "../desktop/state-persistence.js";
import { DesktopSpiderClient } from "../spider/desktop-client.js";
import { findJvmSpider } from "../spider/jvm-spiders.js";
import { resolveJavaExecutable } from "../spikes/java-probe.js";
import {
  runPackagedE2e,
  type PackagedE2eResult,
} from "./e2e-runner.js";
import { resolveElectronRuntime } from "./runtime.js";
import { DesktopShellRuntime } from "./shell-runtime.js";

const APP_NAME = "QX 影视";
const SMOKE_MODE = process.env.QX_ELECTRON_SMOKE === "1";
const E2E_MODE = process.env.QX_ELECTRON_E2E === "1";
const REQUEST_TIMEOUT_MS = numberEnvironment("QX_ELECTRON_REQUEST_TIMEOUT_MS", 30_000);
const STARTUP_TIMEOUT_MS = 5_000;
const PLAYBACK_PROXY_ORIGINS = listEnvironment("QX_PLAYBACK_PROXY_ORIGINS");

if (process.env.QX_E2E_USER_DATA) {
  mkdirSync(process.env.QX_E2E_USER_DATA, { recursive: true });
  app.setPath("userData", process.env.QX_E2E_USER_DATA);
}

let shell: DesktopShellRuntime | undefined;
let mainWindow: BrowserWindow | undefined;
let playerWindow: BrowserWindow | undefined;
let playerWindowUrl: string | undefined;
let uiServer: DesktopSpiderUiServer | undefined;
let cleanupPromise: Promise<void> | undefined;
let quitting = false;
let lastClient: DesktopSpiderClient | undefined;
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

  return new DesktopShellRuntime({
    resolveRuntime: () => resolveElectronRuntime(
      runtimeDirectory(),
      forceExternalJavaDisabled() ? () => null : resolveJavaExecutable,
      { allowBundledJre: !forceBundledJreDisabled() },
    ),
    createServer: (runtime) => {
      const importer = new DesktopSpiderImportController({
        trustStore,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        preferredSiteKey: () => stateStore.state.page.siteKey,
        createSession: (source, config, site) => new DesktopSpiderSession({
          source,
          config,
          trustStore,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          createClient: (selectedSite) => {
            const client = new DesktopSpiderClient({
              api: selectedSite.api ?? site.api ?? "",
              javaExecutable: runtime.javaExecutable,
              hostJar: runtime.hostJar,
              spiderJar: runtime.spiderJar,
              spiderClass: findJvmSpider(selectedSite.api)?.className ?? runtime.spiderClass,
              requestTimeoutMs: REQUEST_TIMEOUT_MS,
              startupTimeoutMs: STARTUP_TIMEOUT_MS,
            });
            lastClient = client;
            return client;
          },
        }),
      });
      const server = new DesktopSpiderUiServer({
        importer,
        rendererDirectory: join(app.getAppPath(), "dist", "renderer"),
        stateStore,
        onPlayerOpen: openPlayerWindow,
        onPlayerAttach: closePlayerWindow,
        onPlayerStop: closePlayerWindow,
        ...(PLAYBACK_PROXY_ORIGINS.length > 0 ? { playbackProxyOrigins: PLAYBACK_PROXY_ORIGINS } : {}),
      });
      uiServer = server;
      return server;
    },
  });
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
        const window = mainWindow;
        if (window && !window.isDestroyed()) window.close();
        await closeShell();
      },
      getSidecarPid: () => lastClient?.pid ?? null,
      waitForSidecarExit: waitForProcessExit,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
