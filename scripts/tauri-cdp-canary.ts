import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installPlaybackObservationExpression, playbackObservationFailures } from "./tauri-playback-observation.js";

import {
  homeObservationExpression,
  playbackNavigationEvidence,
  playbackProxyObservationExpression,
  watchPlaybackActivationExpression,
} from "./tauri-cdp-playback-flow.js";

const loopbackNoProxy = [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost", "::1"]
  .filter((value): value is string => Boolean(value && value.trim()))
  .join(",");
process.env.NO_PROXY = loopbackNoProxy;
process.env.no_proxy = loopbackNoProxy;

const projectRoot = resolve(import.meta.dirname, "..");
const executable = resolve(readArg("--exe") ?? defaultExecutable());
const configUrl = readArg("--config-url") ?? "http://xn--z7x900a.net/";
const siteKey = readArg("--site-key");
const expectPreset = process.argv.includes("--expect-preset");
const expectJianpian = process.argv.includes("--expect-jianpian");
const expectDirectHome = process.argv.includes("--expect-direct-home");
const expectedSourceKey = readArg("--expect-source-key");
const expectedSourceCount = readArg("--expect-source-count");
const playbackRequested = process.argv.includes("--playback");
const observeSeconds = readOptionalIndex("--observe-seconds") ?? 0;
let continuousPlayback: Record<string, any> | null = null;
let continuousFailures: string[] = [];
const g124Requested = process.argv.includes("--g124");
const resumeOnly = process.argv.includes("--resume-only");
const preferHls = process.argv.includes("--prefer-hls");
const searchKey = readArg("--search-key") ?? "流浪地球";
const homeTitle = readArg("--home-title");
const detailId = readArg("--detail-id");
const requestedLineIndex = readOptionalIndex("--line-index");
const requestedEpisodeIndex = readOptionalIndex("--episode-index");
const searchWaitAttempts = Number.parseInt(process.env.QX_TAURI_CDP_SEARCH_ATTEMPTS ?? "120", 10);
const playbackWaitAttempts = Number.parseInt(process.env.QX_TAURI_CDP_PLAYBACK_ATTEMPTS ?? "60", 10);
const outputPath = readArg("--output");
const installerPath = readArg("--installer");
const keepData = process.argv.includes("--keep-data");
const dataRootArg = readArg("--data-root");
const screenshotDirectoryArg = readArg("--screenshot-dir");
const minimumResumeSeconds = Number.parseFloat(readArg("--minimum-resume-seconds") ?? "15");
if (g124Requested && !playbackRequested) throw new Error("TAURI_CDP_G124_REQUIRES_PLAYBACK");
const installerEvidence = installerPath ? readInstallerEvidence(installerPath) : {};
const cdpPort = await resolveCdpPort();
let requestId = 0;
if (resumeOnly && !dataRootArg) throw new Error("TAURI_CDP_RESUME_DATA_ROOT_REQUIRED");
const dataRoot = dataRootArg ? resolve(dataRootArg) : mkdtempSync(join(tmpdir(), "qx-tauri-cdp-canary-"));
if (dataRootArg) mkdirSync(dataRoot, { recursive: true });
const webviewRoot = join(dataRoot, "webview2");
let child: ChildProcess | undefined;
let childStdout = "";
let childStderr = "";
let activeSocket: WebSocket | undefined;

try {
  child = spawn(executable, [], {
    cwd: projectRoot,
    env: {
      ...process.env,
      QX_TAURI_E2E: "1",
      QX_TAURI_E2E_DATA_ROOT: dataRoot,
      QX_TAURI_E2E_EXIT_AFTER_MS: String(Math.max(180000, (observeSeconds + 150) * 1000)),
      QX_TAURI_E2E_WEBVIEW_DATA_DIR: webviewRoot,
      QX_TAURI_E2E_CDP_PORT: String(cdpPort),
      QX_TAURI_E2E_WEBVIEW_ARGS: process.env.QX_TAURI_E2E_WEBVIEW_ARGS ?? "",
      WEBVIEW2_USER_DATA_FOLDER: webviewRoot,
      NO_PROXY: loopbackNoProxy,
      no_proxy: loopbackNoProxy,
    },
    stdio: ["ignore", "pipe", "pipe"],
    // WebView2 does not start its DevTools endpoint when the GUI process is
    // created with CREATE_NO_WINDOW. Keep the E2E process visible to the
    // desktop session; production launches are unaffected.
    windowsHide: false,
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { childStdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { childStderr += chunk; });

  disableCurrentProcessProxy();
  const socket = await waitForPage();
  activeSocket = socket;
  const networkEvents: Array<Record<string, unknown>> = [];
  const networkRequestUrls = new Map<string, string>();
  const networkEventHandler = (event: MessageEvent<string>) => {
    try {
      const message = JSON.parse(event.data) as {
        method?: string;
        params?: Record<string, unknown>;
      };
      const method = message.method ?? "";
      const params = message.params ?? {};
      if (method === "Network.requestWillBeSent") {
        const request = params.request as Record<string, unknown> | undefined;
        const requestIdValue = String(params.requestId ?? "");
        const requestUrl = typeof request?.url === "string" ? request.url : "";
        if (requestIdValue && requestUrl) networkRequestUrls.set(requestIdValue, requestUrl);
        networkEvents.push({
          event: "request",
          requestId: params.requestId ?? null,
          type: params.type ?? null,
          method: request?.method ?? null,
          url: requestUrl || null,
        });
      } else if (method === "Network.responseReceived") {
        const response = params.response as Record<string, unknown> | undefined;
        const requestIdValue = String(params.requestId ?? "");
        const responseUrl = typeof response?.url === "string" ? response.url : "";
        if (requestIdValue && responseUrl) networkRequestUrls.set(requestIdValue, responseUrl);
        networkEvents.push({
          event: "response",
          requestId: params.requestId ?? null,
          type: params.type ?? null,
          status: response?.status ?? null,
          mimeType: response?.mimeType ?? null,
          url: responseUrl || (networkRequestUrls.get(requestIdValue) ?? null),
        });
      } else if (method === "Network.loadingFailed") {
        networkEvents.push({
          event: "failed",
          requestId: params.requestId ?? null,
          type: params.type ?? null,
          errorText: params.errorText ?? null,
          canceled: params.canceled ?? null,
        });
      } else if (method === "Network.loadingFinished") {
        networkEvents.push({
          event: "finished",
          requestId: params.requestId ?? null,
          url: networkRequestUrls.get(String(params.requestId ?? "")) ?? null,
          encodedDataLength: params.encodedDataLength ?? null,
        });
      } else if (method === "Network.dataReceived") {
        networkEvents.push({
          event: "data",
          requestId: params.requestId ?? null,
          url: networkRequestUrls.get(String(params.requestId ?? "")) ?? null,
          dataLength: params.dataLength ?? null,
          encodedDataLength: params.encodedDataLength ?? null,
        });
      }
      if (networkEvents.length > 400) networkEvents.splice(0, networkEvents.length - 400);
    } catch {
      // Ignore unrelated or malformed DevTools events.
    }
  };
  socket.addEventListener("message", networkEventHandler);
  await sendCdpCommand(socket, "Network.enable");

  mainFlow: {
  if (resumeOnly) {
    await runResumeOnly(socket);
    socket.close();
    break mainFlow;
  }

  try {
    await waitForExpression(socket, expectDirectHome
      ? "Boolean(document.querySelector('#config-input') || document.querySelector('[data-testid=core-app-shell]'))"
      : "Boolean(document.querySelector('#config-input'))");
  } catch (error) {
    const diagnostic = await evaluate(socket, `JSON.stringify({
      currentUrl: location.href,
      title: document.title,
      readyState: document.readyState,
      root: document.querySelector('#vue-renderer')?.outerHTML.slice(0, 12000) ?? null,
      importUi: document.querySelector('[data-testid="config-import-ui"]')?.outerHTML.slice(0, 8000) ?? null,
      bodyText: document.body.innerText.slice(0, 12000),
    })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; initialPageDiagnostic=${String(diagnostic).slice(0, 16000)}`);
  }
  if (expectDirectHome) {
    // Automatic startup may finish before CDP attaches. Validate the final
    // source and catalog below instead of requiring a transient import form.
  } else if (expectPreset) {
    await waitForExpression(socket, `document.querySelector('#config-input')?.value === ${JSON.stringify(configUrl)}`);
  } else {
    await evaluate(socket, `(() => {
      const element = document.querySelector('#config-input');
      if (!(element instanceof HTMLTextAreaElement)) throw new Error('config textarea missing');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(element, ${JSON.stringify(configUrl)});
      element.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => document.querySelector('[data-testid="config-import-form"]')?.requestSubmit(), 0);
      return element.value;
    })()`);
  }

  if (siteKey && !expectDirectHome) {
    try {
      await waitForExpression(socket, `Boolean(document.querySelector('#site-key'))`, 120);
    } catch (error) {
      const diagnostic = await evaluate(socket, `JSON.stringify({
        pending: document.querySelector('#vue-renderer')?.getAttribute('data-pending') ?? null,
        importStatus: document.querySelector('[data-testid="config-import-ui"]')?.getAttribute('data-status') ?? null,
        importText: document.querySelector('[data-testid="config-import-ui"]')?.innerText.slice(0, 8000) ?? null,
        errorText: document.querySelector('[data-testid="error"]')?.innerText.slice(0, 8000) ?? null,
        bodyText: document.body.innerText.slice(0, 12000),
      })`);
      throw new Error(`${error instanceof Error ? error.message : String(error)}; siteSelectorDiagnostic=${String(diagnostic).slice(0, 16000)}`);
    }
    if (expectPreset && expectJianpian) {
      await waitForExpression(socket, `(() => {
        const select = document.querySelector('#site-key');
        if (!(select instanceof HTMLSelectElement)) return false;
        const option = select.selectedOptions[0];
        const value = option?.value ?? '';
        const label = option?.textContent ?? '';
        return /荐片|jianpian/iu.test(value + ' ' + label);
      })()`);
    } else if (expectPreset) {
      await waitForExpression(socket, `document.querySelector('#site-key')?.value === ${JSON.stringify(siteKey)}`);
    } else {
      await evaluate(socket, `(() => {
        const select = document.querySelector('#site-key');
        if (!(select instanceof HTMLSelectElement)) throw new Error('site selector missing');
        const requested = ${JSON.stringify(siteKey)};
        if (![...select.options].some((option) => option.value === requested)) throw new Error('requested site key missing');
        select.value = requested;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return select.value;
      })()`);
      await waitForExpression(socket, `document.querySelector('#site-key')?.value === ${JSON.stringify(siteKey)}`);
    }
  }

  let confirmationText: unknown;
  if (expectDirectHome) {
    confirmationText = await waitForExpression(socket, `(() => {
      const root = document.querySelector('#vue-renderer[data-ready="true"]');
      const shell = document.querySelector('[data-testid="core-app-shell"][data-route="home"]');
      const dialog = document.querySelector('[data-testid="trust-confirmation-dialog"]');
      return root && shell && !dialog ? document.body.innerText : false;
    })()`, 120);
    if (expectJianpian) {
      await waitForExpression(socket, `/(荐片|jianpian)/iu.test(document.body.innerText)`, 120);
    }
  } else {
    confirmationText = await waitForExpression(socket, `document.querySelector('[data-testid="trust-confirmation-dialog"]')?.innerText || false`);
    await waitForExpression(socket, `(() => {
      const button = document.querySelector('[data-action="confirm-import"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    })()`);
    await evaluate(socket, `(() => {
      const button = document.querySelector('[data-action="confirm-import"]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('source confirmation button missing');
      button.click();
      return true;
    })()`);
  }

  let workbenchText: unknown;
  try {
    workbenchText = await waitForExpression(socket, `(() => {
      const root = document.querySelector('#vue-renderer[data-ready="true"]');
      const dialog = document.querySelector('[data-testid="trust-confirmation-dialog"]');
      return root && !dialog ? document.body.innerText : false;
    })()`);
  } catch (error) {
    const diagnostic = await evaluate(socket, `JSON.stringify({
      root: document.querySelector('#vue-renderer')?.outerHTML.slice(0, 500),
      dialog: document.querySelector('[data-testid="trust-confirmation-dialog"]')?.innerText ?? null,
      importStatus: document.querySelector('[data-testid="config-import-ui"]')?.getAttribute('data-status') ?? null,
      bodyText: document.body.innerText.slice(0, 5000),
    })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostic=${String(diagnostic)}`);
  }
  await waitForExpression(socket, `document.querySelector('#vue-renderer')?.getAttribute('data-pending') === ''`, 120);
  await ensureHomeRoute(socket);
  if (siteKey && expectDirectHome) {
    await evaluate(socket, `(() => {
      const button = document.querySelector('[data-action="sidebar-source-status"]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('source switch button missing');
      button.click();
      return true;
    })()`);
    await waitForExpression(socket, `Boolean(document.querySelector('[data-testid="core-source-switch-page"]'))`, 120);
    await evaluate(socket, `(() => {
      const requested = ${JSON.stringify(siteKey)};
      const aliases = (() => {
        const normalized = requested.toLowerCase();
        if (normalized.includes('jpys') || normalized.includes('jianpian')) return ['金牌', '荐片', 'jianpian', 'jpys'];
        if (normalized.includes('feimao')) return ['肥猫', 'feimao'];
        if (normalized === 'mtv' || requested.includes('明星')) return ['明星', 'mtv', '哔哩'];
        return [requested];
      })();
      const cards = [...document.querySelectorAll('[data-testid="core-source-switch-page"] .source-card')];
      const exactCard = cards.find((candidate) => {
        const heading = candidate.querySelector('h3')?.textContent?.trim() ?? '';
        const key = candidate.getAttribute('data-site-key') ?? '';
        return heading === requested || key === requested;
      });
      const card = exactCard ?? cards.find((candidate) => {
        const heading = candidate.querySelector('h3')?.textContent?.trim() ?? '';
        const key = candidate.getAttribute('data-site-key') ?? '';
        const text = candidate.textContent ?? '';
        return aliases.some((alias) => text.includes(alias));
      });
      if (!(card instanceof HTMLElement)) throw new Error('requested source card missing');
      const select = card.querySelector('[data-action="core-select-source"]');
      if (!(select instanceof HTMLButtonElement)) throw new Error('requested source select button missing');
      select.click();
      return true;
    })()`);
    await waitForExpression(socket, `document.querySelector('[data-testid="core-app-shell"]')?.getAttribute('data-selected-site-key') === ${JSON.stringify(siteKey)}`, 120);
    await ensureHomeRoute(socket);
  }
  const homeObservations = await observeHome(socket, Boolean(playbackRequested && !homeTitle));
  if (expectedSourceKey) {
    await waitForExpression(socket, `document.querySelector('[data-testid="core-app-shell"]')?.getAttribute('data-selected-site-key') === ${JSON.stringify(expectedSourceKey)}`);
    homeObservations.selectedSourceKey = expectedSourceKey;
    homeObservations.firstFivePostersLoaded = await waitForExpression(socket, `(() => {
      const posters = [...document.querySelectorAll('[data-testid="vod-poster"]')].slice(0, 5);
      return posters.length === 5 && posters.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0);
    })()`, 120);
  }
  if (expectedSourceCount) {
    await waitForExpression(socket, `document.querySelector('[data-testid="core-app-shell"]')?.getAttribute('data-source-count') === ${JSON.stringify(expectedSourceCount)}`);
    homeObservations.sourceCount = Number(expectedSourceCount);
  }
  if (screenshotDirectoryArg && !g124Requested) {
    const directory = resolve(projectRoot, screenshotDirectoryArg);
    await mkdir(directory, { recursive: true });
    const capture = await sendCdpCommand<{ data: string }>(socket, "Page.captureScreenshot", { format: "png" });
    const path = join(directory, "home.png");
    await writeFile(path, Buffer.from(String(capture.data), "base64"));
    homeObservations.screenshot = path;
    if (expectedSourceCount) {
      await evaluate(socket, `document.querySelector('[data-action="sidebar-source-status"]')?.click()`);
      await waitForExpression(socket, `document.querySelectorAll('[data-testid="core-source-switch-page"] .source-card').length === ${Number(expectedSourceCount)}`);
      const sources = await sendCdpCommand<{ data: string }>(socket, "Page.captureScreenshot", { format: "png" });
      const sourcesPath = join(directory, "sources.png");
      await writeFile(sourcesPath, Buffer.from(sources.data, "base64"));
      homeObservations.sourceListScreenshot = sourcesPath;
      await ensureHomeRoute(socket);
    }
  }
  let playback: Record<string, unknown> | null = null;
  let g124Observations: Record<string, unknown> | null = null;
  if (playbackRequested) {
    await waitForExpression(socket, `Boolean(document.querySelector('[data-testid="search-form"]'))`);
    await evaluate(socket, `(() => {
      const internals = window.__TAURI_INTERNALS__;
      if (!internals || typeof internals.invoke !== 'function') return false;
      if (internals.__qxInvokeTrace) return true;
      const original = internals.invoke.bind(internals);
      const trace: unknown[] = [];
      internals.__qxInvokeTrace = trace;
      internals.invoke = async (...args: unknown[]) => {
        const command = typeof args[0] === 'string' ? args[0] : '';
        const traced = command === 'backend_source_session'
          || command === 'backend_playback_start'
          || command === 'backend_playback_proxy'
          || command === 'backend_player_window'
          || command === 'backend_desktop_services'
          || command === 'backend_business_features';
        const entry = { command, args: args[1], status: 'pending' };
        if (traced) trace.push(entry);
        try {
          const value = await original(...args);
          if (traced) Object.assign(entry, { status: 'resolved', value });
          return value;
        } catch (error) {
          if (traced) Object.assign(entry, { status: 'rejected', error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      };
      return true;
    })()`);
    if (detailId) {
      await evaluate(socket, `(() => {
        const id = ${JSON.stringify(detailId)};
        location.hash = '#/media/' + encodeURIComponent(id);
        return location.hash;
      })()`);
    } else if (homeTitle) {
      await evaluate(socket, `(() => {
        const page = document.querySelector('[data-testid="core-app-shell"][data-route="home"] [data-testid="core-browse-page"][data-route="home"]');
        const heading = [...(page?.querySelectorAll('[data-testid="vod-card"] h3') ?? [])]
          .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(homeTitle)});
        const card = heading?.closest('[data-testid="vod-card"]');
        if (!(card instanceof HTMLElement)) throw new Error('home playback card missing');
        card.click();
        return card.getAttribute('data-od-id');
      })()`);
    } else {
      await evaluate(socket, `(() => {
      const input = document.querySelector('#search-key');
      if (!(input instanceof HTMLInputElement)) throw new Error('search input missing');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, ${JSON.stringify(searchKey)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => document.querySelector('[data-testid="search-form"]')?.requestSubmit(), 0);
      return input.value;
      })()`);
      try {
      await waitForExpression(socket, `(() => {
        const requestedSource = ${JSON.stringify(siteKey ?? "")};
        const aliases = (() => {
          const normalized = requestedSource.toLowerCase();
          if (normalized.includes('jpys') || normalized.includes('jianpian') || requestedSource.includes('荐片')) return ['金牌', '荐片', 'jianpian', 'jpys'];
          if (normalized.includes('feimao') || requestedSource.includes('肥猫')) return ['肥猫', 'feimao'];
          if (normalized === 'mtv' || requestedSource.includes('明星')) return ['明星', 'mtv', '哔哩'];
          return [requestedSource];
        })();
        const scope = requestedSource
          ? [...document.querySelectorAll('[data-testid="core-search-source-row"]')]
              .find((row) => row.getAttribute('data-source-key') === requestedSource
                || aliases.some((alias) => row.textContent?.includes(alias)))
          : document;
        if (!scope) return false;
        return [...scope.querySelectorAll('[data-testid="vod-card"] h3')]
          .some((heading) => heading.textContent?.includes(${JSON.stringify(searchKey)}));
      })()`, Number.isInteger(searchWaitAttempts) && searchWaitAttempts > 0 ? searchWaitAttempts : 120);
    } catch (error) {
      const diagnostic = await evaluate(socket, `JSON.stringify({
        currentUrl: location.href,
        tauriInternals: Boolean(window.__TAURI_INTERNALS__),
        tauriInvoke: typeof window.__TAURI_INTERNALS__?.invoke,
        pending: document.querySelector('#vue-renderer')?.getAttribute('data-pending') ?? null,
        page: document.querySelector('#vue-renderer')?.getAttribute('data-page') ?? null,
        errorPanel: document.querySelector('[data-testid="error"]')?.innerText ?? null,
        diagnostics: [...document.querySelectorAll('[data-testid="diagnostic-panel"], [data-testid="error-diagnostic"]')]
          .map((element) => element.innerText)
          .join("\\n"),
        cards: [...document.querySelectorAll('[data-testid="vod-card"]')]
          .slice(0, 20)
          .map((card) => card.textContent?.trim() ?? ""),
        sourceCalls: (() => {
          const trace = window.__TAURI_INTERNALS__?.__qxInvokeTrace;
          if (!Array.isArray(trace)) return [];
          return trace.slice(-80).map((entry) => {
            const request = entry?.args?.request;
            const payload = request?.payload;
            const value = entry?.value;
            const response = value?.payload ?? value;
            const result = response?.payload?.result ?? response?.result;
            const list = result?.list;
            return {
              action: payload?.action ?? null,
              method: payload?.method ?? null,
              siteKey: payload?.siteKey ?? null,
              api: payload?.api ?? null,
              ok: value?.ok ?? response?.ok ?? null,
              resultKeys: result && typeof result === 'object' ? Object.keys(result).slice(0, 12) : [],
              listCount: Array.isArray(list) ? list.length : null,
              error: value?.error?.error?.reasonCode ?? response?.error?.reasonCode ?? null,
            };
          });
        })(),
        bodyText: document.body.innerText.slice(0, 12000),
      })`);
      throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostic=${String(diagnostic)}`);
      }
      await evaluate(socket, `(() => {
      const requestedSource = ${JSON.stringify(siteKey ?? "")};
      const aliases = (() => {
        const normalized = requestedSource.toLowerCase();
        if (normalized.includes('jpys') || normalized.includes('jianpian') || requestedSource.includes('荐片')) return ['金牌', '荐片', 'jianpian', 'jpys'];
        if (normalized.includes('feimao') || requestedSource.includes('肥猫')) return ['肥猫', 'feimao'];
        if (normalized === 'mtv' || requestedSource.includes('明星')) return ['明星', 'mtv', '哔哩'];
        return [requestedSource];
      })();
      const scope = requestedSource
        ? [...document.querySelectorAll('[data-testid="core-search-source-row"]')]
            .find((row) => row.getAttribute('data-source-key') === requestedSource
              || aliases.some((alias) => row.textContent?.includes(alias)))
        : document;
      if (!scope) throw new Error('requested search source row missing');
      const heading = [...scope.querySelectorAll('[data-testid="vod-card"] h3')]
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(searchKey)}));
      const card = heading?.closest('[data-testid="vod-card"]');
      if (!(card instanceof HTMLElement)) throw new Error('search result card missing');
      card.click();
      return card.getAttribute('data-od-id');
      })()`);
    }
    try {
      await waitForExpression(socket, `Boolean(document.querySelector('[data-testid="detail-drawer"], [data-testid="core-media-detail-page"]'))`, 120);
    } catch (error) {
      const diagnostic = await evaluate(socket, `JSON.stringify({
        currentUrl: location.href,
        pending: document.querySelector('#vue-renderer')?.getAttribute('data-pending') ?? null,
        renderer: document.querySelector('#vue-renderer')?.outerHTML.slice(0, 12000) ?? null,
        errorPanel: document.querySelector('[data-testid="error"]')?.innerText ?? null,
        diagnostics: [...document.querySelectorAll('[data-testid="diagnostic-panel"], [data-testid="error-diagnostic"]')]
          .map((element) => element.innerText)
          .join("\\n"),
        card: [...document.querySelectorAll('[data-testid="vod-card"]')]
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(searchKey)}))?.outerHTML.slice(0, 5000) ?? null,
        bodyText: document.body.innerText.slice(0, 12000),
      })`);
      throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostic=${String(diagnostic)}`);
    }
    const detailLibrary = g124Requested ? await ensureDetailLibrary(socket) : null;
    if (observeSeconds) await evaluate(socket, installPlaybackObservationExpression());
    if (requestedLineIndex !== undefined || preferHls) {
      await waitForExpression(socket, `(() => {
        if (document.querySelector('#vue-renderer')?.getAttribute('data-pending') !== '') return false;
        const requestedLine = ${JSON.stringify(requestedLineIndex === undefined ? null : String(requestedLineIndex))};
        const button = [...document.querySelectorAll('[data-testid="playback-selector"] [data-action="playback-line"]')]
          .find((candidate) => (requestedLine === null
              ? candidate.getAttribute('data-protocol')?.toLowerCase() === 'hls'
              : candidate.getAttribute('data-line-index') === requestedLine)
            && candidate.getClientRects().length > 0);
        return button instanceof HTMLButtonElement && !button.disabled;
      })()`, 120);
      await evaluate(socket, `(() => {
        const requestedLine = ${JSON.stringify(requestedLineIndex === undefined ? null : String(requestedLineIndex))};
        const button = [...document.querySelectorAll('[data-testid="playback-selector"] [data-action="playback-line"]')]
          .find((candidate) => (requestedLine === null
              ? candidate.getAttribute('data-protocol')?.toLowerCase() === 'hls'
              : candidate.getAttribute('data-line-index') === requestedLine)
            && candidate.getClientRects().length > 0);
        if (!(button instanceof HTMLButtonElement)) throw new Error('requested playback line missing');
        button.click();
        return button.getAttribute('data-line-index');
      })()`);
      await waitForExpression(socket, `(() => {
        const requestedLine = ${JSON.stringify(requestedLineIndex === undefined ? null : String(requestedLineIndex))};
        const button = [...document.querySelectorAll('[data-testid="playback-selector"] [data-action="playback-line"]')]
          .find((candidate) => (requestedLine === null
              ? candidate.getAttribute('data-protocol')?.toLowerCase() === 'hls'
              : candidate.getAttribute('data-line-index') === requestedLine)
            && candidate.getClientRects().length > 0);
        return button instanceof HTMLButtonElement && button.getAttribute('aria-selected') === 'true';
      })()`, 120);
      await waitForExpression(socket, `document.querySelector('#vue-renderer')?.getAttribute('data-pending') === ''`, 120);
    }
    if (requestedEpisodeIndex !== undefined) {
      await waitForExpression(socket, `(() => {
        if (document.querySelector('#vue-renderer')?.getAttribute('data-pending') !== '') return false;
        const button = [...document.querySelectorAll('[data-testid="playback-selector"] [data-action="player-episode"]')]
          .find((candidate) => candidate.getAttribute('data-episode-index') === ${JSON.stringify(String(requestedEpisodeIndex))}
            && candidate.getClientRects().length > 0);
        return button instanceof HTMLButtonElement && !button.disabled;
      })()`, 120);
      await evaluate(socket, `(() => {
        const button = [...document.querySelectorAll('[data-testid="playback-selector"] [data-action="player-episode"]')]
          .find((candidate) => candidate.getAttribute('data-episode-index') === ${JSON.stringify(String(requestedEpisodeIndex))}
            && candidate.getClientRects().length > 0);
        if (!(button instanceof HTMLButtonElement)) throw new Error('requested playback episode missing');
        button.click();
        return {
          lineIndex: button.getAttribute('data-line-index'),
          episodeIndex: button.getAttribute('data-episode-index'),
          episodeName: button.textContent?.trim() ?? '',
        };
      })()`);
    } else if (requestedLineIndex !== undefined || preferHls) {
      await waitForExpression(socket, `(() => {
        const button = document.querySelector('[data-action="play"], [data-action="core-detail-play"]');
        return button instanceof HTMLButtonElement && !button.disabled;
      })()`, 120);
      await evaluate(socket, `(() => {
        const button = document.querySelector('[data-action="play"], [data-action="core-detail-play"]');
        if (!(button instanceof HTMLButtonElement)) throw new Error('play button missing after HLS selection');
        button.click();
        return true;
      })()`);
    } else {
      try {
        await waitForExpression(socket, `(() => {
          const button = document.querySelector('[data-action="play"], [data-action="core-detail-play"]');
          return button instanceof HTMLButtonElement && !button.disabled;
        })()`, 120);
      } catch (error) {
        const diagnostic = await evaluate(socket, `JSON.stringify({
          currentUrl: location.href,
          pending: document.querySelector('#vue-renderer')?.getAttribute('data-pending') ?? null,
          errorPanel: document.querySelector('[data-testid="error"]')?.innerText ?? null,
          detail: document.querySelector('[data-testid="core-media-detail-page"], [data-testid="detail-drawer"]')?.outerHTML.slice(0, 16000) ?? null,
          bodyText: document.body.innerText.slice(0, 16000),
        })`);
        throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostic=${String(diagnostic)}`);
      }
      await evaluate(socket, `(() => {
        const button = document.querySelector('[data-action="play"], [data-action="core-detail-play"]');
        if (!(button instanceof HTMLButtonElement)) throw new Error('play button missing');
        button.click();
        return true;
      })()`);
    }
    const activation = await waitForExpression(
      socket,
      watchPlaybackActivationExpression(false),
      120,
    );
    if (activation === "watch-ready") {
      await evaluate(socket, watchPlaybackActivationExpression(true));
    }
    try {
      await waitForExpression(socket, `Boolean(document.querySelector('[data-testid="embedded-player"]'))`, 120);
    } catch (error) {
      const diagnostic = await evaluate(socket, `JSON.stringify({
        currentUrl: location.href,
        pending: document.querySelector('#vue-renderer')?.getAttribute('data-pending') ?? null,
        page: document.querySelector('#vue-renderer')?.getAttribute('data-page') ?? null,
        errorPanel: document.querySelector('[data-testid="error"]')?.innerText ?? null,
        playerButtons: [...document.querySelectorAll('[data-action="playback-line"], [data-action="player-episode"], [data-action="play"], [data-action="core-detail-play"]')]
          .slice(0, 40)
          .map((button) => ({
            action: button.getAttribute('data-action'),
            lineIndex: button.getAttribute('data-line-index'),
            episodeIndex: button.getAttribute('data-episode-index'),
            label: button.textContent?.trim() ?? null,
            protocol: button.getAttribute('data-protocol'),
            selected: button.getAttribute('aria-selected') ?? button.getAttribute('aria-pressed'),
            playIdLength: button.getAttribute('data-play-id')?.length ?? null,
          })),
        sourceCalls: (() => {
          const trace = window.__TAURI_INTERNALS__?.__qxInvokeTrace;
          if (!Array.isArray(trace)) return [];
          return trace.slice(-40).map((entry) => {
            const command = entry?.command ?? null;
            const payload = entry?.args?.request?.payload;
            const value = entry?.value;
            const response = value?.payload ?? value;
            const result = response?.payload?.result ?? response?.result;
            return {
              command,
              action: payload?.action ?? null,
              method: payload?.method ?? null,
              siteKey: payload?.siteKey ?? null,
              ok: value?.ok ?? response?.ok ?? null,
              resultKeys: result && typeof result === 'object' ? Object.keys(result).slice(0, 12) : [],
              error: value?.error?.error?.reasonCode ?? response?.error?.reasonCode ?? null,
              playerSource: command === 'backend_playback_start'
                ? {
                    backend: response?.playerSource?.backend ?? response?.payload?.playerSource?.backend ?? null,
                    mediaType: response?.playerSource?.mediaType ?? response?.payload?.playerSource?.mediaType ?? null,
                    parse: response?.playerSource?.parse ?? response?.payload?.playerSource?.parse ?? null,
                    urlHost: (() => {
                      const raw = response?.playerSource?.url ?? response?.payload?.playerSource?.url;
                      try { return raw ? new URL(raw).host : null; } catch { return null; }
                    })(),
                  }
                : null,
            };
          });
        })(),
        bodyText: document.body.innerText.slice(-12000),
      })`);
      throw new Error(`${error instanceof Error ? error.message : String(error)}; postLinePlaybackDiagnostic=${String(diagnostic).slice(0, 16000)}`);
    }
    await evaluate(socket, `(() => {
      const video = document.querySelector('[data-testid="embedded-player"]');
      if (!(video instanceof HTMLVideoElement)) throw new Error('embedded video missing');
      video.muted = true;
      return {
        currentTime: video.currentTime,
        readyState: video.readyState,
        currentSrc: video.currentSrc || video.src,
      };
    })()`);
    let playbackSnapshot: unknown;
    try {
      playbackSnapshot = await waitForExpression(socket, `(() => {
        const video = document.querySelector('[data-testid="embedded-player"]');
        if (!(video instanceof HTMLVideoElement) || video.currentTime < 20 || video.videoWidth <= 0 || video.videoHeight <= 0) return false;
        const line = document.querySelector('[data-testid="playback-selector"] [data-action="playback-line"][aria-selected="true"]');
        const episode = document.querySelector('[data-testid="playback-selector"] [data-action="player-episode"][aria-pressed="true"]');
        return JSON.stringify({
          currentTime: video.currentTime,
          duration: video.duration,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          readyState: video.readyState,
          currentSrc: video.currentSrc,
          playerStatus: document.querySelector('[data-testid="player-status"]')?.textContent ?? null,
          selectedLineIndex: line?.getAttribute('data-line-index') ?? null,
          selectedLineName: line?.querySelector('.playback-line-label')?.textContent?.trim() ?? null,
          selectedEpisodeIndex: episode?.getAttribute('data-episode-index') ?? null,
          selectedEpisodeName: episode?.textContent?.trim() ?? null,
        });
      })()`, Number.isInteger(playbackWaitAttempts) && playbackWaitAttempts > 0 ? playbackWaitAttempts : 60);
    } catch (error) {
      const manifestBodies: Array<Record<string, unknown>> = [];
      const manifestRequestIds = [...new Set(networkEvents
        .filter((entry) => entry.event === "response"
          && typeof entry.requestId === "string"
          && typeof entry.url === "string"
          && (/__qx_playback|\.m3u8(?:$|[?#])/iu.test(entry.url)))
        .map((entry) => String(entry.requestId)))];
      for (const requestIdValue of manifestRequestIds.slice(-4)) {
        const responseEvent = networkEvents.find((entry) => entry.event === "response" && entry.requestId === requestIdValue);
        const responseUrl = typeof responseEvent?.url === "string" ? responseEvent.url : "";
        const responseMimeType = typeof responseEvent?.mimeType === "string" ? responseEvent.mimeType : "";
        const isTextManifest = /\.m3u8(?:$|[?#])/iu.test(responseUrl)
          || /(?:mpegurl|application\/vnd\.apple\.mpegurl|text\/)/iu.test(responseMimeType);
        if (!isTextManifest) {
          manifestBodies.push({
            requestId: requestIdValue,
            url: responseUrl || null,
            mimeType: responseMimeType || null,
            bodySkipped: "non-text response",
          });
          continue;
        }
        try {
          const response = await sendCdpCommand<{ body?: string; base64Encoded?: boolean }>(socket, "Network.getResponseBody", { requestId: requestIdValue });
          manifestBodies.push({
            requestId: requestIdValue,
            url: responseEvent?.url ?? null,
            base64Encoded: response.base64Encoded ?? false,
            body: String(response.body ?? "").slice(0, 12000),
          });
        } catch (bodyError) {
          manifestBodies.push({
            requestId: requestIdValue,
            url: responseEvent?.url ?? null,
            bodyError: bodyError instanceof Error ? bodyError.message : String(bodyError),
          });
        }
      }
      let manifestFetch: unknown = null;
      const manifestUrl = [...networkEvents]
        .reverse()
        .find((entry) => entry.event === "response" && typeof entry.url === "string" && /__qx_playback|\.m3u8(?:$|[?#])/iu.test(entry.url))
        ?.url;
      if (typeof manifestUrl === "string") {
        try {
          manifestFetch = await evaluate(socket, `fetch(${JSON.stringify(manifestUrl)}).then(async (response) => {
            const contentType = response.headers.get('content-type');
            const contentLength = response.headers.get('content-length');
            const isTextManifest = /(?:mpegurl|application\/vnd\.apple\.mpegurl|text\/)/iu.test(contentType ?? '')
              || /\.m3u8(?:$|[?#])/iu.test(response.url);
            return {
              status: response.status,
              contentType,
              contentLength,
              body: isTextManifest ? (await response.text()).slice(0, 12000) : null,
              bodySkipped: isTextManifest ? null : 'non-text response',
            };
          })`, { timeoutMs: 10_000 });
        } catch (fetchError) {
          manifestFetch = { error: fetchError instanceof Error ? fetchError.message : String(fetchError) };
        }
      }
      const nodeManifestFetch = typeof manifestUrl === "string"
        ? await fetchHttpPreview(manifestUrl)
        : null;
      const diagnostic = await evaluate(socket, `JSON.stringify((() => {
        const video = document.querySelector('[data-testid="embedded-player"]');
        const mediaError = video instanceof HTMLVideoElement ? video.error : null;
        const playerPanel = document.querySelector('[data-testid="embedded-player-panel"]');
        const buffered = video instanceof HTMLVideoElement
          ? Array.from({ length: video.buffered.length }, (_, index) => [video.buffered.start(index), video.buffered.end(index)])
          : [];
        const resourceUrls = [...new Set(performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter((raw) => {
            try {
              const url = new URL(raw);
              return url.pathname.includes('/__qx_playback/')
                || /\.m3u8(?:$|[?#])|\.mp4(?:$|[?#])/iu.test(raw);
            } catch {
              return false;
            }
          }))].slice(-80);
        return {
          video: video instanceof HTMLVideoElement ? {
            currentTime: video.currentTime,
            duration: video.duration,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            readyState: video.readyState,
            networkState: video.networkState,
            paused: video.paused,
            ended: video.ended,
            buffered,
            src: video.src,
            currentSrc: video.currentSrc,
            crossOrigin: video.crossOrigin,
            preload: video.preload,
            hasSource: Boolean(video.currentSrc || video.src),
            errorCode: mediaError?.code ?? null,
          } : null,
          selectedPlayback: (() => {
            const line = document.querySelector('[data-testid="playback-selector"] [data-action="playback-line"][aria-selected="true"]');
            const episode = document.querySelector('[data-testid="playback-selector"] [data-action="player-episode"][aria-pressed="true"]');
            return {
              lineIndex: line?.getAttribute('data-line-index') ?? null,
              lineName: line?.querySelector('.playback-line-label')?.textContent?.trim() ?? null,
              lineProtocol: line?.getAttribute('data-protocol') ?? null,
              episodeIndex: episode?.getAttribute('data-episode-index') ?? null,
              episodeName: episode?.textContent?.trim() ?? null,
            };
          })(),
          sourceCalls: (() => {
            const trace = window.__TAURI_INTERNALS__?.__qxInvokeTrace;
            if (!Array.isArray(trace)) return [];
            return trace.slice(-80).flatMap((entry) => {
              if (entry?.command !== 'backend_source_session' && entry?.command !== 'backend_playback_start') return [];
              const payload = entry?.args?.request?.payload;
              const value = entry?.value;
              const response = value?.payload ?? value;
              const result = response?.payload?.result ?? response?.result;
              const playerSource = response?.playerSource ?? response?.payload?.playerSource;
              const safeUrl = (raw) => {
                try {
                  const url = new URL(String(raw));
                  return { protocol: url.protocol, host: url.host, path: url.pathname };
                } catch {
                  return null;
                }
              };
              return [{
                command: entry.command,
                status: entry.status ?? null,
                action: payload?.action ?? null,
                method: payload?.method ?? null,
                siteKey: payload?.siteKey ?? null,
                playerRequestIdLength: payload?.method === 'player' ? String(payload?.params?.id ?? '').length : null,
                playerResult: payload?.method === 'player' ? {
                  parse: result?.parse ?? null,
                  url: safeUrl(result?.url),
                } : null,
                playerSource: playerSource ? {
                  backend: playerSource.backend ?? null,
                  mediaType: playerSource.mediaType ?? null,
                  parse: playerSource.parse ?? null,
                  url: safeUrl(playerSource.url),
                } : null,
                error: entry?.error ?? value?.error?.error?.reasonCode ?? response?.error?.reasonCode ?? null,
              }];
            });
          })(),
          nodeManifestFetch: ${JSON.stringify(nodeManifestFetch)},
          playerStatus: document.querySelector('[data-testid="player-status"]')?.textContent ?? null,
          playerState: playerPanel?.getAttribute('data-player-status') ?? null,
          hlsStage: playerPanel?.getAttribute('data-hls-stage') ?? null,
          hlsError: playerPanel?.getAttribute('data-hls-error') ?? null,
          resourceUrls,
          networkEvents: ${JSON.stringify(networkEvents.filter((entry) => {
            const url = String(entry.url ?? "");
            return entry.type === "Media" || /__qx_playback|\.m3u8(?:$|[?#])|\.(?:ts|m4s)(?:$|[?#])/iu.test(url);
          }).slice(-120))},
          manifestBodies: ${JSON.stringify(manifestBodies)},
          manifestFetch: ${JSON.stringify(manifestFetch)},
          playerPanel: playerPanel?.outerHTML.slice(0, 5000) ?? null,
          bodyText: document.body.innerText.slice(-6000),
        };
      })())`);
      throw new Error(`${error instanceof Error ? error.message : String(error)}; playbackDiagnostic=${String(diagnostic).slice(0, 12000)}; childStderr=${childStderr.slice(-8000)}`);
    }
    playback = JSON.parse(String(playbackSnapshot)) as Record<string, unknown>;
    if (observeSeconds) {
      const until = Date.now() + (observeSeconds + 15) * 1000;
      while (Date.now() < until) {
        continuousPlayback = parseJsonResult(await evaluate(socket, 'JSON.stringify(window.__qxPlaybackObservation)'));
        if (continuousPlayback.ended || continuousPlayback.errors?.length
          || continuousPlayback.samples?.at(-1)?.elapsedMs >= observeSeconds * 1000) break;
        await delay(1000);
      }
      continuousFailures = playbackObservationFailures(continuousPlayback ?? {}, observeSeconds);
      playback = { ...playback, currentTime: continuousPlayback?.lastTime ?? playback.currentTime };
    }
    if (g124Requested) {
      g124Observations = {
        ...detailLibrary,
        ...(await runG124Matrix(socket, playback)),
      };
    }
  }
  const result = await evaluate(socket, `JSON.stringify({
    configUrl: ${JSON.stringify(configUrl)},
    confirmationObserved: true,
    workbenchObserved: true,
    sourceUnavailableHandled: document.body.innerText.includes("SOURCE_SESSION_REQUEST_FAILED")
      || document.body.innerText.includes("TAURI_SOURCE_HOME_FAILED"),
    bodyText: document.body.innerText.slice(0, 5000),
  })`);
  const resultValue = JSON.parse(String(result)) as Record<string, unknown>;
  assertNoChildRuntimePanic(childStderr);
  if (playbackRequested && playback) {
    const navigationEvidence = playbackNavigationEvidence({ detailId, homeTitle, searchKey });
    const tauriPlaybackProxy = Boolean(await evaluate(socket, playbackProxyObservationExpression()));
    const report = {
      schemaVersion: "v1",
      evidenceType: g124Requested ? "tauri-g124-player-library-e2e" : "tauri-hls-20s-e2e",
      verified: continuousFailures.length === 0,
      realHttp: true,
      mockUsed: false,
      durationSeconds: Number(playback.currentTime),
      observedAt: new Date().toISOString(),
      package: executable,
      ...installerEvidence,
      source: {
        configUrl,
        siteKey: siteKey ?? null,
        searchKey: navigationEvidence.searchKey,
        detailId: navigationEvidence.detailId,
        homeTitle: navigationEvidence.homeTitle,
        lineIndex: requestedLineIndex ?? null,
        episodeIndex: requestedEpisodeIndex ?? null,
      },
      observations: {
        ...homeObservations,
        navigationMode: navigationEvidence.navigationMode,
        nativeSearchAndDetail: navigationEvidence.nativeSearchAndDetail,
        tauriPlaybackProxy,
        firstFrameObserved: Number(playback.currentTime) >= 20,
        progressBeforeSeconds: 0,
        progressAfterSeconds: Number(playback.currentTime),
        durationSeconds: Number(playback.duration),
        videoWidth: Number(playback.videoWidth),
        videoHeight: Number(playback.videoHeight),
        readyState: Number(playback.readyState),
        selectedLineIndex: playback.selectedLineIndex ?? null,
        selectedLineName: playback.selectedLineName ?? null,
        selectedEpisodeIndex: playback.selectedEpisodeIndex ?? null,
        selectedEpisodeName: playback.selectedEpisodeName ?? null,
        mockUsed: false,
        ...(g124Observations ?? {}),
        ...(continuousPlayback ? { continuousPlayback, continuousFailures, requiredSeconds: observeSeconds } : {}),
      },
    };
    if (outputPath) await writeFile(resolve(projectRoot, outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
    if (continuousFailures.length) throw new Error(`CONTINUOUS_PLAYBACK_REJECTED:${continuousFailures.join(",")}`);
  } else {
    console.log(JSON.stringify({
      schemaVersion: "v1",
      evidenceType: "tauri-cdp-canary",
      verified: true,
      executable,
      configUrl,
      siteKey: siteKey ?? null,
      playbackRequested,
      searchKey: playbackRequested ? searchKey : null,
      lineIndex: playbackRequested ? requestedLineIndex ?? null : null,
      episodeIndex: playbackRequested ? requestedEpisodeIndex ?? null : null,
      playback,
      confirmationText: String(confirmationText).slice(0, 2000),
      workbenchText: String(workbenchText).slice(0, 2000),
      observations: homeObservations,
      result: resultValue,
    }, null, 2));
  }
  }
} catch (error) {
  let failurePage: unknown = null;
  if (activeSocket?.readyState === WebSocket.OPEN) {
    failurePage = await evaluate(activeSocket, `JSON.stringify({
      page: document.body.innerText.slice(0, 6000),
      posters: [...document.querySelectorAll('[data-testid="vod-poster"]')].slice(0, 5)
        .map(image => ({complete: image.complete, width: image.naturalWidth, height: image.naturalHeight})),
      video: (() => { const video = document.querySelector('video'); return video ? {
        time: video.currentTime, readyState: video.readyState, width: video.videoWidth, height: video.videoHeight,
        decoded: video.getVideoPlaybackQuality().totalVideoFrames, error: video.error?.code ?? null,
      } : null; })(),
    })`, { timeoutMs: 2_000 }).catch(() => null);
    if (screenshotDirectoryArg) {
      const directory = resolve(projectRoot, screenshotDirectoryArg);
      await mkdir(directory, { recursive: true });
      const capture = await sendCdpCommand<{ data: string }>(activeSocket, "Page.captureScreenshot", { format: "png" }).catch(() => null);
      if (capture) await writeFile(join(directory, "failure.png"), Buffer.from(capture.data, "base64"));
    }
  }
  if (outputPath) {
    await writeFile(resolve(projectRoot, outputPath), `${JSON.stringify({
      schemaVersion: "v1", evidenceType: "tauri-cdp-canary", verified: false,
      observedAt: new Date().toISOString(), package: executable, realHttp: true, mockUsed: false,
      source: { configUrl, siteKey, searchKey, detailId, lineIndex: requestedLineIndex, episodeIndex: requestedEpisodeIndex },
      failure: error instanceof Error ? error.message : String(error),
      observations: { failurePage, continuousPlayback, continuousFailures, requiredSeconds: observeSeconds },
    }, null, 2)}\n`, "utf8");
  }
  throw error;
} finally {
  // Exercise the product's close path before using a bounded test cleanup.
  let gracefulExit = child?.exitCode !== null;
  if (child && child.exitCode === null && activeSocket?.readyState === WebSocket.OPEN) {
    await evaluate(activeSocket, `(() => {
      const close = document.querySelector('[data-action="window-close"]');
      if (!(close instanceof HTMLButtonElement)) return false;
      close.click(); return true;
    })()`, { timeoutMs: 2_000 }).catch(() => undefined);
    for (let attempt = 0; attempt < 30 && child.exitCode === null; attempt++) await delay(100);
    gracefulExit = child.exitCode !== null;
  }
  if (activeSocket?.readyState === WebSocket.OPEN) activeSocket.close();
  if (child && child.exitCode === null) {
    child.kill();
    for (let attempt = 0; attempt < 30 && child.exitCode === null && child.signalCode === null; attempt++) await delay(100);
  }
  if (outputPath) await writeFile(resolve(projectRoot, `${outputPath}.cleanup.json`), `${JSON.stringify({
    gracefulExit, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null,
  }, null, 2)}\n`, "utf8");
  if (keepData || dataRootArg) {
    console.error(`TAURI_CDP_DATA_ROOT=${dataRoot}`);
  } else {
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

async function ensureHomeRoute(socket: WebSocket): Promise<void> {
  await evaluate(socket, `(() => {
    if (document.querySelector('[data-testid="core-app-shell"][data-route="home"] [data-testid="core-browse-page"][data-route="home"]')) return 'already-home';
    const tab = document.querySelector('[data-testid="category-tabs"] [data-action="home-tab"]');
    const sidebar = document.querySelector('[data-testid="app-sidebar"] [data-action="home"]');
    const button = [tab, sidebar]
      .find((candidate) => candidate instanceof HTMLButtonElement && !candidate.disabled);
    if (!(button instanceof HTMLButtonElement)) throw new Error('home navigation button missing');
    button.click();
    return 'navigating-home';
  })()`);
  await waitForExpression(socket, `Boolean(document.querySelector('[data-testid="core-app-shell"][data-route="home"] [data-testid="core-browse-page"][data-route="home"]'))`, 120);
  await waitForExpression(socket, `document.querySelector('#vue-renderer')?.getAttribute('data-pending') === ''`, 120);
}

async function observeHome(
  socket: WebSocket,
  allowEmpty: boolean,
): Promise<Record<string, unknown>> {
  try {
    const snapshot = await waitForExpression(
      socket,
      homeObservationExpression(allowEmpty),
      120,
    );
    return parseJsonResult(snapshot);
  } catch (error) {
    const diagnostic = await evaluate(socket, `JSON.stringify({
      currentUrl: location.href,
      pending: document.querySelector('#vue-renderer')?.getAttribute('data-pending') ?? null,
      page: document.querySelector('#vue-renderer')?.getAttribute('data-page') ?? null,
      errorPanel: document.querySelector('[data-testid="error"]')?.innerText ?? null,
      diagnostics: [...document.querySelectorAll('[data-testid="diagnostic-panel"], [data-testid="error-diagnostic"]')]
        .map((element) => element.textContent?.trim() ?? '')
        .join("\\n"),
      cardCount: document.querySelectorAll('[data-testid="vod-card"]').length,
      cards: [...document.querySelectorAll('[data-testid="vod-card"]')]
        .slice(0, 5)
        .map((card) => {
          const poster = card.querySelector('[data-testid="vod-poster"]');
          return {
            title: card.querySelector('h3')?.textContent?.trim() ?? '',
            visible: card instanceof HTMLElement && card.getClientRects().length > 0,
            poster: poster instanceof HTMLImageElement ? {
              complete: poster.complete,
              naturalWidth: poster.naturalWidth,
              naturalHeight: poster.naturalHeight,
              currentSrc: poster.currentSrc,
              src: poster.src,
            } : {
              tagName: poster?.tagName ?? null,
              html: poster?.outerHTML.slice(0, 1000) ?? null,
            },
          };
        }),
      bodyText: document.body.innerText.slice(0, 12000),
    })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; homeDiagnostic=${String(diagnostic).slice(0, 16000)}`);
  }
}

async function ensureDetailLibrary(socket: WebSocket): Promise<Record<string, unknown>> {
  for (const action of ["core-detail-favorite", "core-detail-follow"] as const) {
    await waitForExpression(socket, `(() => {
      const button = document.querySelector('[data-action="${action}"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    })()`);
    await evaluate(socket, `(() => {
      const button = document.querySelector('[data-action="${action}"]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('${action} missing');
      if (button.getAttribute('aria-pressed') !== 'true') button.click();
      return true;
    })()`);
    await waitForExpression(socket, `document.querySelector('[data-action="${action}"]')?.getAttribute('aria-pressed') === 'true'`, 120);
  }
  return { favoritePersistedFromDetail: true, followPersistedFromDetail: true };
}

async function runG124Matrix(socket: WebSocket, initialPlayback: Record<string, unknown>): Promise<Record<string, unknown>> {
  await evaluate(socket, `(() => {
    const input = document.querySelector('[data-action="player-volume"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('player volume missing');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '0.37');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const volumeSnapshot = parseJsonResult(await waitForExpression(socket, `(() => {
    const video = document.querySelector('[data-testid="embedded-player"]');
    if (!(video instanceof HTMLVideoElement) || Math.abs(video.volume - 0.37) > 0.02 || video.muted) return false;
    return JSON.stringify({ volume: video.volume, muted: video.muted });
  })()`));

  await waitForExpression(socket, `document.querySelector('[data-testid="embedded-player-panel"]')?.getAttribute('data-player-status') === 'playing'`, 60);
  await evaluate(socket, `(() => {
    const stage = document.querySelector('[data-testid="embedded-player-stage"]');
    if (!(stage instanceof HTMLElement)) throw new Error('player stage missing');
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    stage.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    stage.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    return true;
  })()`);
  await waitForExpression(socket, `document.querySelector('[data-testid="embedded-player-stage"]')?.classList.contains('is-controls-hidden') === true`, 12);
  await evaluate(socket, `(() => {
    const input = document.querySelector('[data-action="player-volume"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('player volume missing');
    input.focus({ preventScroll: true });
    return document.activeElement === input;
  })()`);
  await waitForExpression(socket, `document.activeElement?.getAttribute('data-action') === 'player-volume'`, 5);
  await delay(2_800);
  const focusSnapshot = parseJsonResult(await evaluate(socket, `JSON.stringify((() => {
    const stage = document.querySelector('[data-testid="embedded-player-stage"]');
    const overlay = document.querySelector('[data-testid="player-controls-overlay"]');
    const active = document.activeElement;
    const style = overlay instanceof HTMLElement ? getComputedStyle(overlay) : null;
    return {
      focusInside: stage instanceof HTMLElement && active instanceof Element && stage.contains(active),
      activeAction: active instanceof Element ? active.getAttribute('data-action') : null,
      controlsHiddenClass: stage instanceof HTMLElement && stage.classList.contains('is-controls-hidden'),
      opacity: style?.opacity ?? null,
      pointerEvents: style?.pointerEvents ?? null,
    };
  })())`));
  if (
    focusSnapshot.focusInside !== true
    || focusSnapshot.activeAction !== "player-volume"
    || focusSnapshot.opacity !== "1"
    || focusSnapshot.pointerEvents === "none"
  ) throw new Error(`TAURI_G124_FOCUS_AUTO_HIDE_FAILED:${JSON.stringify(focusSnapshot)}`);
  await evaluate(socket, `(() => {
    const input = document.querySelector('[data-action="player-volume"]');
    const stage = document.querySelector('[data-testid="embedded-player-stage"]');
    if (input instanceof HTMLElement) input.blur();
    if (stage instanceof HTMLElement) stage.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    return true;
  })()`);
  await waitForExpression(socket, `document.querySelector('[data-testid="embedded-player-stage"]')?.classList.contains('is-controls-hidden') === true`, 12);

  await evaluate(socket, `(() => {
    const stage = document.querySelector('[data-testid="embedded-player-stage"]');
    if (stage instanceof HTMLElement) stage.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    const button = document.querySelector('[data-action="player-fullscreen"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('fullscreen button missing');
    button.click();
    return true;
  })()`, { userGesture: true });
  await waitForExpression(socket, `Boolean(document.fullscreenElement) && document.querySelector('[data-testid="embedded-player-stage"]')?.getAttribute('data-fullscreen') === 'true'`, 20);
  await evaluate(socket, `document.exitFullscreen().then(() => true)`, { userGesture: true });
  await waitForExpression(socket, `!document.fullscreenElement && document.querySelector('[data-testid="embedded-player-stage"]')?.getAttribute('data-fullscreen') === 'false'`, 20);

  const beforeDetach = parseJsonResult(await evaluate(socket, `JSON.stringify((() => {
    const video = document.querySelector('[data-testid="embedded-player"]');
    if (!(video instanceof HTMLVideoElement)) throw new Error('embedded video missing before detach');
    return { currentTime: video.currentTime, duration: video.duration, volume: video.volume, muted: video.muted };
  })())`));
  await evaluate(socket, `(() => {
    const details = document.querySelector('.player-secondary-controls');
    if (details instanceof HTMLDetailsElement) details.open = true;
    const button = document.querySelector('[data-action="player-detach"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('detach button missing');
    window.__qxDetachClickSeen = 0;
    button.addEventListener('click', () => { window.__qxDetachClickSeen += 1; }, { once: true });
    button.click();
    return true;
  })()`);
  try {
    await waitForExpression(socket, `Boolean(document.querySelector('[data-testid="core-detached-player-panel"]')) && !document.querySelector('[data-testid="embedded-player"]')`, 60);
  } catch (error) {
    const diagnostic = await evaluate(socket, `JSON.stringify({
      pending: document.querySelector('#vue-renderer')?.getAttribute('data-pending') ?? null,
      route: document.querySelector('[data-testid="core-app-shell"]')?.getAttribute('data-route') ?? null,
      detachedPanel: document.querySelector('[data-testid="core-detached-player-panel"]')?.outerHTML.slice(0, 3000) ?? null,
      embeddedPlayer: document.querySelector('[data-testid="embedded-player-panel"]')?.outerHTML.slice(0, 3000) ?? null,
      error: document.querySelector('[data-testid="error"]')?.innerText ?? null,
      errorStates: [...document.querySelectorAll('[data-testid="error-state"]')].map((element) => element.innerText),
      detachClickSeen: window.__qxDetachClickSeen ?? null,
      playerWindowCalls: Array.isArray(window.__TAURI_INTERNALS__?.__qxInvokeTrace)
        ? window.__TAURI_INTERNALS__.__qxInvokeTrace.filter((entry) => entry?.command === 'backend_player_window').slice(-10)
        : [],
      syncCalls: Array.isArray(window.__TAURI_INTERNALS__?.__qxInvokeTrace)
        ? window.__TAURI_INTERNALS__.__qxInvokeTrace.filter((entry) => entry?.command === 'backend_desktop_services' || entry?.command === 'backend_business_features').slice(-30)
        : [],
      bodyText: document.body.innerText.slice(-10000),
    })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; detachDiagnostic=${String(diagnostic).slice(0, 18000)}`);
  }

  const playerTarget = await waitForPlayerWindowTarget();
  const playerSocket = new WebSocket(normalizeWebSocketUrl(playerTarget.webSocketDebuggerUrl));
  await waitForSocket(playerSocket, playerTarget.webSocketDebuggerUrl);
  const detachedSnapshot = parseJsonResult(await waitForExpression(playerSocket, `(() => {
    const video = document.querySelector('[data-testid="embedded-player"]');
    if (!(video instanceof HTMLVideoElement) || video.videoWidth <= 0 || video.currentTime < ${Math.max(0, Number(beforeDetach.currentTime) - 3)}) return false;
    return JSON.stringify({ currentTime: video.currentTime, duration: video.duration, volume: video.volume, muted: video.muted, paused: video.paused });
  })()`, 120));
  const detachedTargetTime = Math.min(
    Math.max(0, Number(detachedSnapshot.duration) - 5),
    Math.max(Number(detachedSnapshot.currentTime) + 5, Number(initialPlayback.currentTime) + 5),
  );
  await evaluate(playerSocket, `(() => {
    const video = document.querySelector('[data-testid="embedded-player"]');
    const volume = document.querySelector('[data-action="player-volume"]');
    if (!(video instanceof HTMLVideoElement) || !(volume instanceof HTMLInputElement)) throw new Error('detached controls missing');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(volume, '0.24');
    volume.dispatchEvent(new Event('input', { bubbles: true }));
    video.currentTime = ${detachedTargetTime};
    video.dispatchEvent(new Event('timeupdate'));
    video.pause();
    video.dispatchEvent(new Event('pause'));
    return true;
  })()`);
  await delay(1_000);
  const detachedPaused = parseJsonResult(await evaluate(playerSocket, `JSON.stringify((() => {
    const video = document.querySelector('[data-testid="embedded-player"]');
    if (!(video instanceof HTMLVideoElement)) throw new Error('detached video missing');
    return { currentTime: video.currentTime, volume: video.volume, muted: video.muted, paused: video.paused };
  })())`));
  await evaluate(playerSocket, `(() => {
    const button = document.querySelector('[data-action="player-attach"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('attach button missing');
    button.click();
    return true;
  })()`).catch((error: unknown) => {
    if (!(error instanceof Error) || !error.message.includes("SOCKET_CLOSED")) throw error;
  });
  await waitForExpression(socket, `Boolean(document.querySelector('[data-testid="embedded-player"]')) && !document.querySelector('[data-testid="core-detached-player-panel"]')`, 120);
  const reattached = parseJsonResult(await waitForExpression(socket, `(() => {
    const video = document.querySelector('[data-testid="embedded-player"]');
    if (!(video instanceof HTMLVideoElement)) return false;
    if (video.currentTime < ${Math.max(0, detachedTargetTime - 3)} || Math.abs(video.volume - 0.24) > 0.02 || !video.paused) return false;
    return JSON.stringify({ currentTime: video.currentTime, volume: video.volume, muted: video.muted, paused: video.paused });
  })()`, 120));
  playerSocket.close();

  const history = await openLibraryPage(socket, "history", "history-page", "history-list");
  await evaluate(socket, `(() => {
    const button = document.querySelector('[data-action="history-open"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('history open missing');
    button.click();
    return true;
  })()`);
  await waitForExpression(socket, `Boolean(document.querySelector('[data-testid="core-media-detail-page"]')) && Boolean(document.querySelector('[data-testid="core-history-resume-prompt"]')) && !document.querySelector('[data-testid="embedded-player"]')`, 120);
  const historyOpensDetailWithoutAutoplay = true;
  const favorites = await openLibraryPage(socket, "favorites", "favorites-page", "favorites-list");
  const follow = await openLibraryPage(socket, "follow", "follow-page", "follow-list");
  const screenshots = await captureG124Screenshots(socket);

  return {
    volumeControl: volumeSnapshot,
    controlsAutoHide: true,
    focusKeepsControls: true,
    fullscreenEnteredAndExited: true,
    beforeDetach,
    detachedSnapshot,
    detachedPaused,
    reattached,
    detachedStateSynchronized: true,
    history,
    favorites,
    follow,
    historyOpensDetailWithoutAutoplay,
    screenshots,
  };
}

async function openLibraryPage(socket: WebSocket, action: string, pageTestId: string, listTestId: string): Promise<Record<string, unknown>> {
  await evaluate(socket, `(() => {
    const button = document.querySelector('[data-action="${action}"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('${action} navigation missing');
    button.click();
    return true;
  })()`);
  const snapshot = parseJsonResult(await waitForExpression(socket, `(() => {
    const page = document.querySelector('[data-testid="${pageTestId}"]');
    const list = document.querySelector('[data-testid="${listTestId}"]');
    if (!(page instanceof HTMLElement) || !(list instanceof HTMLElement) || !page.innerText.includes(${JSON.stringify(searchKey)})) return false;
    const item = list.querySelector('article');
    return JSON.stringify({
      titleObserved: true,
      itemCount: list.querySelectorAll('article').length,
      sourceAvailable: item?.getAttribute('data-available') ?? null,
      text: item?.textContent?.trim().slice(0, 500) ?? list.textContent?.trim().slice(0, 500) ?? '',
    });
  })()`, 120));
  await waitForExpression(socket, `document.querySelector('#vue-renderer')?.getAttribute('data-pending') === ''`, 120);
  return snapshot;
}

async function captureG124Screenshots(socket: WebSocket): Promise<string[]> {
  const directory = screenshotDirectoryArg ? resolve(projectRoot, screenshotDirectoryArg) : join(dataRoot, "g124-screenshots");
  await mkdir(directory, { recursive: true });
  const screenshots: string[] = [];
  const sizes = [[1280, 800], [1440, 900], [1920, 1080]] as const;
  for (const theme of ["light", "dark"] as const) {
    await evaluate(socket, `(() => {
      const shell = document.querySelector('[data-testid="core-app-shell"]');
      const button = document.querySelector('[data-action="theme-toggle"]');
      if (!(shell instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) throw new Error('theme controls missing');
      if (shell.getAttribute('data-theme') !== '${theme}') button.click();
      return true;
    })()`);
    await waitForExpression(socket, `document.querySelector('[data-testid="core-app-shell"]')?.getAttribute('data-theme') === '${theme}'`, 20);
    for (const [width, height] of sizes) {
      await sendCdpCommand(socket, "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await delay(150);
      const capture = await sendCdpCommand<{ data: string }>(socket, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      if (!capture.data) throw new Error("TAURI_G124_SCREENSHOT_EMPTY");
      const path = join(directory, `${width}x${height}-${theme}.png`);
      await writeFile(path, Buffer.from(capture.data, "base64"));
      screenshots.push(path);
    }
  }
  await sendCdpCommand(socket, "Emulation.clearDeviceMetricsOverride");
  return screenshots;
}

async function runResumeOnly(socket: WebSocket): Promise<void> {
  if (!Number.isFinite(minimumResumeSeconds) || minimumResumeSeconds <= 0) throw new Error("TAURI_CDP_RESUME_SECONDS_INVALID");
  await waitForExpression(socket, `Boolean(document.querySelector('#vue-renderer[data-ready="true"]')) && Boolean(document.querySelector('[data-testid="search-form"]'))`, 120);
  const favorites = await openLibraryPage(socket, "favorites", "favorites-page", "favorites-list");
  const follow = await openLibraryPage(socket, "follow", "follow-page", "follow-list");
  const history = await openLibraryPage(socket, "history", "history-page", "history-list");
  await evaluate(socket, `(() => {
    const button = document.querySelector('[data-action="history-open"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('persisted history open missing');
    button.click();
    return true;
  })()`);
  const resumePrompt = await waitForExpression(socket, `document.querySelector('[data-testid="core-history-resume-prompt"]')?.innerText || false`, 120);
  const expectedResumeSeconds = resumePositionFromPrompt(String(resumePrompt));
  if (!Number.isFinite(expectedResumeSeconds)) throw new Error("TAURI_G124_RESUME_POSITION_MISSING");
  await evaluate(socket, `(() => {
    const button = document.querySelector('[data-action="core-history-resume"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('resume button missing');
    button.click();
    return true;
  })()`);
  const resumed = parseJsonResult(await waitForExpression(socket, `(() => {
    const video = document.querySelector('[data-testid="embedded-player"]');
    if (!(video instanceof HTMLVideoElement) || video.videoWidth <= 0 || !Number.isFinite(video.duration) || video.duration <= 0) return false;
    return JSON.stringify({ currentTime: video.currentTime, duration: video.duration, videoWidth: video.videoWidth, videoHeight: video.videoHeight });
  })()`, 120));
  const requiredResumeSeconds = Math.max(minimumResumeSeconds, expectedResumeSeconds - 3);
  if (Number(resumed.currentTime) < requiredResumeSeconds) {
    throw new Error(`TAURI_G124_RESUME_POSITION_FAILED:${JSON.stringify({ expectedResumeSeconds, requiredResumeSeconds, resumed })}`);
  }
  const report = {
    schemaVersion: "v1",
    evidenceType: "tauri-g124-restart-resume-e2e",
    verified: true,
    observedAt: new Date().toISOString(),
    package: executable,
    source: { configUrl, siteKey: siteKey ?? null, searchKey },
    observations: {
      persistedHistory: history,
      persistedFavorites: favorites,
      persistedFollow: follow,
      resumePrompt: String(resumePrompt).slice(0, 500),
      resumed,
      expectedResumeSeconds,
      requiredResumeSeconds,
      minimumResumeSeconds,
    },
  };
  if (outputPath) await writeFile(resolve(projectRoot, outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

function resumePositionFromPrompt(value: string): number {
  const match = value.match(/已播放\s*(\d+):([0-5]\d)/u);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

async function waitForPlayerWindowTarget(): Promise<CdpTarget> {
  let lastTargets: CdpTarget[] = [];
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const port = readDevToolsPort();
    if (port) {
      lastTargets = await readCdpTargets(port).catch(() => []);
      const target = lastTargets.find((candidate) => candidate.type === "page"
        && candidate.url.includes("player-window=1")
        && Boolean(candidate.webSocketDebuggerUrl));
      if (target) return target;
    }
    await delay(250);
  }
  throw new Error(`TAURI_G124_PLAYER_TARGET_NOT_FOUND:${JSON.stringify(lastTargets).slice(0, 4000)}`);
}

function parseJsonResult(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("TAURI_CDP_JSON_RESULT_INVALID");
  return parsed as Record<string, unknown>;
}

function readInstallerEvidence(pathValue: string): { installer: string; installerSha256: string; installerBytes: number } {
  const installer = resolve(pathValue);
  const bytes = readFileSync(installer);
  const size = statSync(installer).size;
  if (bytes.length === 0 || size !== bytes.length) throw new Error("TAURI_CDP_INSTALLER_INVALID");
  return {
    installer,
    installerSha256: createHash("sha256").update(bytes).digest("hex"),
    installerBytes: size,
  };
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readOptionalIndex(name: string): number | undefined {
  const raw = readArg(name);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0 || String(value) !== raw.trim()) {
    throw new Error(`TAURI_CDP_INDEX_INVALID:${name}`);
  }
  return value;
}

function assertNoChildRuntimePanic(stderr: string): void {
  if (stderr.includes("Cannot drop a runtime in a context where blocking is not allowed")) {
    throw new Error("TAURI_CDP_CHILD_RUNTIME_PANIC");
  }
}

async function resolveCdpPort(): Promise<number> {
  const requested = readArg("--cdp-port") ?? process.env.QX_TAURI_E2E_CDP_PORT;
  if (requested) {
    const port = Number.parseInt(requested, 10);
    if (Number.isInteger(port) && port >= 0 && port < 65_536) return port;
    throw new Error("TAURI_CDP_PORT_INVALID");
  }
  // WebView2 151 reliably exposes DevToolsActivePort when asked to choose
  // the port itself; fixed ports may be silently ignored by the runtime.
  return 0;
}

async function waitForPage(): Promise<WebSocket> {
  let lastTargets: CdpTarget[] = [];
  let lastError = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`TAURI_CDP_PROCESS_EXITED: ${child.exitCode}; stdout=${childStdout.slice(-2000)}; stderr=${childStderr.slice(-4000)}`);
    }
    try {
      const detectedPort = readDevToolsPort();
      const activePort = detectedPort ?? (cdpPort > 0 ? cdpPort : undefined);
      if (activePort) {
        const targets = await readCdpTargets(activePort);
        lastTargets = targets;
        const pages = targets.filter(isApplicationTarget);
        for (const page of pages) {
          const websocketUrl = normalizeWebSocketUrl(page.webSocketDebuggerUrl);
          const socket = new WebSocket(websocketUrl);
          try {
            await waitForSocket(socket, websocketUrl, 2_000);
            const href = await evaluate(socket, "location.href", { timeoutMs: 2_000 });
            if (!isApplicationUrl(href)) {
              throw new Error(`TAURI_CDP_TARGET_URL_MISMATCH:${String(href)}`);
            }
            return socket;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            socket.close();
          }
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // WebView2 is still starting.
    }
    await delay(500);
  }
  throw new Error(`TAURI_CDP_PAGE_NOT_FOUND; cdpPort=${cdpPort ?? "unknown"}; lastError=${lastError}; targets=${JSON.stringify(lastTargets).slice(0, 4000)}; stdout=${childStdout.slice(-2000)}; stderr=${childStderr.slice(-4000)}`);
}

function isApplicationTarget(target: CdpTarget): boolean {
  return target.type === "page"
    && Boolean(target.webSocketDebuggerUrl)
    && isApplicationUrl(target.url);
}

function isApplicationUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && (url.hostname === "tauri.localhost"
        || (url.hostname === "localhost" && url.port === "5173"));
  } catch {
    return false;
  }
}

function readCdpTargets(port: number): Promise<CdpTarget[]> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      { hostname: "127.0.0.1", port, path: "/json/list", method: "GET", timeout: 1_000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.once("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`CDP_HTTP_STATUS:${response.statusCode ?? "unknown"}`));
            return;
          }
          try {
            resolvePromise(JSON.parse(body) as CdpTarget[]);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error("CDP_HTTP_TIMEOUT")));
    request.once("error", reject);
    request.end();
  });
}

function readDevToolsPort(): number | undefined {
  const candidates = [
    join(webviewRoot, "EBWebView", "DevToolsActivePort"),
    join(webviewRoot, "DevToolsActivePort"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const port = Number.parseInt(readFileSync(candidate, "utf8").split(/\r?\n/u)[0] ?? "", 10);
    if (Number.isInteger(port) && port > 0 && port < 65_536) return port;
  }
  return undefined;
}

async function fetchHttpPreview(rawUrl: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(rawUrl, { signal: controller.signal });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    let truncated = false;
    const limit = 64 * 1024;
    if (reader) {
      while (bytesRead <= limit) {
        const next = await reader.read();
        if (next.done) break;
        const remaining = limit - bytesRead;
        if (next.value.byteLength > remaining) {
          chunks.push(next.value.slice(0, remaining));
          bytesRead += remaining;
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(next.value);
        bytesRead += next.value.byteLength;
      }
    }
    const bytes = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const textLike = contentType.startsWith("text/")
      || contentType.includes("mpegurl")
      || contentType.includes("dash+xml")
      || (bytes.length >= 7
        && bytes.slice(0, 7).every((value, index) => value === "#EXTM3U".charCodeAt(index)));
    return {
      status: response.status,
      contentType: contentType || null,
      contentLength: response.headers.get("content-length"),
      previewBytes: bytes.length,
      truncated,
      ...(textLike
        ? { body: new TextDecoder().decode(bytes.slice(0, 12_000)) }
        : { sampleHex: Buffer.from(bytes.slice(0, 32)).toString("hex") }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function disableCurrentProcessProxy(): void {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    delete process.env[name];
  }
}

function defaultExecutable(): string {
  const fallback = "src-tauri/target/debug/qx-yingshi.exe";
  const candidates = [
    fallback,
    "src-tauri/target/x86_64-pc-windows-msvc/debug/qx-yingshi.exe",
  ];
  return candidates
    .find((candidate) => existsSync(resolve(candidate)))
    ?? fallback;
}

function normalizeWebSocketUrl(raw: string): string {
  const url = new URL(raw);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  if (url.hostname === "[::1]") url.hostname = "127.0.0.1";
  return url.toString();
}

async function waitForSocket(socket: WebSocket, url: string, timeoutMs = 2_000): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise();
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onOpen = () => finishResolve();
    const onClose = () => finishReject(new Error(`TAURI_CDP_SOCKET_CLOSED:${url}`));
    const onError = () => finishReject(new Error(`TAURI_CDP_SOCKET_FAILED:${url}`));
    const timer = setTimeout(
      () => finishReject(new Error(`TAURI_CDP_SOCKET_TIMEOUT:${url}`)),
      timeoutMs,
    );
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

async function evaluate(
  socket: WebSocket,
  expression: string,
  options: { userGesture?: boolean; timeoutMs?: number } = {},
): Promise<unknown> {
  const id = ++requestId;
  const expressionSummary = expression.replace(/\s+/gu, " ").slice(0, 240);
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finishReject(new Error(`TAURI_CDP_EVAL_TIMEOUT:${id}:${expressionSummary}`)),
      options.timeoutMs ?? 15_000,
    );
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", handler);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const finishResolve = (value: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handler = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as { id?: number; result?: { result?: { value?: unknown } }; error?: unknown };
      if (message.id !== id) return;
      if (message.error) {
        finishReject(new Error(JSON.stringify(message.error)));
        return;
      }
      finishResolve(message.result?.result?.value);
    };
    const onClose = () => finishReject(new Error("TAURI_CDP_SOCKET_CLOSED"));
    const onError = () => finishReject(new Error("TAURI_CDP_SOCKET_ERROR"));
    socket.addEventListener("message", handler);
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError, { once: true });
    try {
      socket.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true, userGesture: options.userGesture ?? false },
      }));
    } catch (error) {
      finishReject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function sendCdpCommand<T extends Record<string, unknown> = Record<string, unknown>>(
  socket: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const id = ++requestId;
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const timer = setTimeout(() => finishReject(new Error(`TAURI_CDP_COMMAND_TIMEOUT:${method}:${id}`)), 15_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", handler);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const finishResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handler = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as { id?: number; result?: T; error?: unknown };
      if (message.id !== id) return;
      if (message.error) {
        finishReject(new Error(JSON.stringify(message.error)));
        return;
      }
      finishResolve(message.result ?? {} as T);
    };
    const onClose = () => finishReject(new Error("TAURI_CDP_SOCKET_CLOSED"));
    const onError = () => finishReject(new Error("TAURI_CDP_SOCKET_ERROR"));
    socket.addEventListener("message", handler);
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError, { once: true });
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      finishReject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function waitForExpression(socket: WebSocket, expression: string, maxAttempts = 60): Promise<unknown> {
  let lastValue: unknown = false;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    lastValue = await evaluate(socket, expression);
    if (lastValue) return lastValue;
    await delay(500);
  }
  throw new Error(`TAURI_CDP_WAIT_TIMEOUT: ${expression}; lastValue=${JSON.stringify(lastValue).slice(0, 2000)}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}
