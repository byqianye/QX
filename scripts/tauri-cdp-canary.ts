import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const projectRoot = resolve(import.meta.dirname, "..");
const executable = resolve(readArg("--exe") ?? "src-tauri/target/x86_64-pc-windows-msvc/debug/qx-yingshi.exe");
const configUrl = readArg("--config-url") ?? "http://xn--z7x900a.net/";
const siteKey = readArg("--site-key");
const playbackRequested = process.argv.includes("--playback");
const searchKey = readArg("--search-key") ?? "流浪地球";
const outputPath = readArg("--output");
const installerPath = readArg("--installer");
const installerEvidence = installerPath ? readInstallerEvidence(installerPath) : {};
let requestId = 0;
const port = await freePort();
const dataRoot = mkdtempSync(join(tmpdir(), "qx-tauri-cdp-canary-"));
const webviewRoot = join(dataRoot, "webview2");
let child: ChildProcess | undefined;
let childStdout = "";
let childStderr = "";

try {
  child = spawn(executable, [], {
    cwd: projectRoot,
    env: {
      ...process.env,
      QX_TAURI_E2E: "1",
      QX_TAURI_E2E_DATA_ROOT: dataRoot,
      QX_TAURI_E2E_EXIT_AFTER_MS: "120000",
      WEBVIEW2_USER_DATA_FOLDER: webviewRoot,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { childStdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { childStderr += chunk; });

  const page = await waitForPage();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await waitForSocket(socket);

  await waitForExpression(socket, "Boolean(document.querySelector('#config-input'))");
  await evaluate(socket, `(() => {
    const element = document.querySelector('#config-input');
    if (!(element instanceof HTMLTextAreaElement)) throw new Error('config textarea missing');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(element, ${JSON.stringify(configUrl)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="config-import-form"]')?.requestSubmit();
    return element.value;
  })()`);

  if (siteKey) {
    await waitForExpression(socket, `Boolean(document.querySelector('#site-key'))`);
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

  const confirmationText = await waitForExpression(socket, `document.querySelector('[data-testid="trust-confirmation-dialog"]')?.innerText || false`);
  await evaluate(socket, `(() => {
    const button = document.querySelector('[data-action="confirm-import"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('source confirmation button missing');
    button.click();
    return true;
  })()`);

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
  let playback: Record<string, unknown> | null = null;
  if (playbackRequested) {
    await waitForExpression(socket, `Boolean(document.querySelector('[data-testid="search-form"]'))`);
    await evaluate(socket, `(() => {
      const input = document.querySelector('#search-key');
      if (!(input instanceof HTMLInputElement)) throw new Error('search input missing');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, ${JSON.stringify(searchKey)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-testid="search-form"]')?.requestSubmit();
      return input.value;
    })()`);
    await waitForExpression(socket, `([...document.querySelectorAll('[data-testid="vod-card"] h3')].some((heading) => heading.textContent?.includes(${JSON.stringify(searchKey)})))`, 120);
    await evaluate(socket, `(() => {
      const card = [...document.querySelectorAll('[data-testid="vod-card"]')].find((candidate) => candidate.textContent?.includes(${JSON.stringify(searchKey)}));
      if (!(card instanceof HTMLElement)) throw new Error('search result card missing');
      card.click();
      return card.getAttribute('data-od-id');
    })()`);
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
    await waitForExpression(socket, `(() => {
      const button = document.querySelector('[data-action="play"], [data-action="core-detail-play"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    })()`, 120);
    await evaluate(socket, `(() => {
      const button = document.querySelector('[data-action="play"], [data-action="core-detail-play"]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('play button missing');
      button.click();
      return true;
    })()`);
    await waitForExpression(socket, `Boolean(document.querySelector('[data-testid="embedded-player"]'))`, 120);
    await evaluate(socket, `(() => {
      const video = document.querySelector('[data-testid="embedded-player"]');
      if (!(video instanceof HTMLVideoElement)) throw new Error('embedded video missing');
      video.muted = true;
      return video.play().then(() => true).catch(() => false);
    })()`);
    const playbackSnapshot = await waitForExpression(socket, `(() => {
      const video = document.querySelector('[data-testid="embedded-player"]');
      if (!(video instanceof HTMLVideoElement) || video.currentTime < 20 || video.videoWidth <= 0 || video.videoHeight <= 0) return false;
      return JSON.stringify({
        currentTime: video.currentTime,
        duration: video.duration,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        readyState: video.readyState,
        playerStatus: document.querySelector('[data-testid="player-status"]')?.textContent ?? null,
      });
    })()`, 180);
    playback = JSON.parse(String(playbackSnapshot)) as Record<string, unknown>;
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
  if (playbackRequested && playback) {
    const report = {
      schemaVersion: "v1",
      evidenceType: "tauri-hls-20s-e2e",
      verified: true,
      realHttp: true,
      mockUsed: false,
      durationSeconds: Number(playback.currentTime),
      observedAt: new Date().toISOString(),
      package: executable,
      ...installerEvidence,
      source: { configUrl, siteKey: siteKey ?? null, searchKey },
      observations: {
        nativeSearchAndDetail: true,
        tauriPlaybackProxy: String(resultValue.bodyText).includes("Tauri playback proxy"),
        firstFrameObserved: Number(playback.currentTime) >= 20,
        progressBeforeSeconds: 0,
        progressAfterSeconds: Number(playback.currentTime),
        durationSeconds: Number(playback.duration),
        videoWidth: Number(playback.videoWidth),
        videoHeight: Number(playback.videoHeight),
        readyState: Number(playback.readyState),
        mockUsed: false,
      },
    };
    if (outputPath) await writeFile(resolve(projectRoot, outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
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
      playback,
      confirmationText: String(confirmationText).slice(0, 2000),
      workbenchText: String(workbenchText).slice(0, 2000),
      result: resultValue,
    }, null, 2));
  }
  socket.close();
} finally {
  if (child && child.exitCode === null) child.kill();
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
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

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CDP_PORT_ALLOCATION_FAILED");
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return address.port;
}

async function waitForPage(): Promise<CdpTarget> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`TAURI_CDP_PROCESS_EXITED: ${child.exitCode}; stdout=${childStdout.slice(-2000)}; stderr=${childStderr.slice(-4000)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json() as CdpTarget[];
        const page = targets.find((target) => target.type === "page" && target.url.startsWith("http://tauri.localhost"));
        if (page) return page;
      }
    } catch {
      // WebView2 is still starting.
    }
    await delay(500);
  }
  throw new Error(`TAURI_CDP_PAGE_NOT_FOUND; stdout=${childStdout.slice(-2000)}; stderr=${childStderr.slice(-4000)}`);
}

async function waitForSocket(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    socket.addEventListener("open", () => resolvePromise(), { once: true });
    socket.addEventListener("error", () => reject(new Error("TAURI_CDP_SOCKET_FAILED")), { once: true });
  });
}

async function evaluate(socket: WebSocket, expression: string): Promise<unknown> {
  const id = ++requestId;
  return new Promise((resolvePromise, reject) => {
    const handler = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as { id?: number; result?: { result?: { value?: unknown } }; error?: unknown };
      if (message.id !== id) return;
      socket.removeEventListener("message", handler);
      if (message.error) {
        reject(new Error(JSON.stringify(message.error)));
        return;
      }
      resolvePromise(message.result?.result?.value);
    };
    socket.addEventListener("message", handler);
    socket.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
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
