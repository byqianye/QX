import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseTvBoxConfig,
  summarizeConfig,
  type ConfigSummary,
  type TvBoxConfig,
  type TvBoxSite,
} from "../config/decoder.js";
import {
  ImportTrustStore,
  inspectImport,
  type ImportAssessment,
  type ImportSourceKind,
} from "../config/trust.js";
import { routeSpiderApi } from "../spider/rpc.js";
import { findJvmSpider } from "../spider/jvm-spiders.js";
import type { DesktopSpiderSessionPort } from "./spider-ui.js";

export type DesktopSpiderImportInputKind = "url" | "file" | "json";
export type DesktopSpiderImportStatus =
  | "empty"
  | "loading"
  | "confirmation_required"
  | "ready"
  | "cancelled"
  | "error";

export interface DesktopSpiderImportSite {
  key: string;
  name: string;
  api: string;
}

export interface DesktopSpiderImportState {
  status: DesktopSpiderImportStatus;
  loading: boolean;
  inputKind: DesktopSpiderImportInputKind | null;
  source: string | null;
  sourceKind: ImportSourceKind | null;
  warning: string | null;
  error: { code: string; message: string } | null;
  trusted: boolean;
  summary: ConfigSummary | null;
  sites: readonly DesktopSpiderImportSite[];
  selectedSiteKey: string | null;
  selectedApi: string | null;
  sessionReady: boolean;
}

export interface DesktopSpiderImportOptions {
  trustStore: ImportTrustStore;
  createSession: (
    source: string,
    config: TvBoxConfig,
    site: TvBoxSite,
  ) => DesktopSpiderSessionPort;
  fetchText?: (url: string, timeoutMs: number) => Promise<string>;
  readFile?: (path: string) => string;
  requestTimeoutMs?: number;
}

export class DesktopSpiderImportController {
  private readonly trustStore: ImportTrustStore;
  private readonly createSession: DesktopSpiderImportOptions["createSession"];
  private readonly fetchText: (url: string, timeoutMs: number) => Promise<string>;
  private readonly readFile: (path: string) => string;
  private readonly requestTimeoutMs: number;
  private currentSession: DesktopSpiderSessionPort | undefined;
  private config: TvBoxConfig | undefined;
  private assessment: ImportAssessment | undefined;
  private selectedSite: TvBoxSite | undefined;
  private stateValue: DesktopSpiderImportState = emptyState();

  public constructor(options: DesktopSpiderImportOptions) {
    this.trustStore = options.trustStore;
    this.createSession = options.createSession;
    this.fetchText = options.fetchText ?? fetchImportText;
    this.readFile = options.readFile ?? ((path) => readFileSync(path, "utf8"));
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  public get state(): DesktopSpiderImportState {
    return {
      ...this.stateValue,
      summary: this.stateValue.summary
        ? { ...this.stateValue.summary, engineCounts: { ...this.stateValue.summary.engineCounts } }
        : null,
      sites: this.stateValue.sites.map((site) => ({ ...site })),
      sessionReady: this.currentSession !== undefined
        && this.currentSession.view.status !== "destroyed",
    };
  }

  public get session(): DesktopSpiderSessionPort | undefined {
    return this.currentSession;
  }

  public get selectedSiteKey(): string | null {
    return this.selectedSite ? siteKeyOf(this.selectedSite) : null;
  }

  public get selectedExt(): string {
    return typeof this.selectedSite?.ext === "string" ? this.selectedSite.ext : "";
  }

  public async import(input: string): Promise<DesktopSpiderImportState> {
    await this.releaseCurrentSession();
    this.config = undefined;
    this.assessment = undefined;
    this.selectedSite = undefined;

    let descriptor: ImportDescriptor;
    try {
      descriptor = describeInput(input, this.fetchText, this.readFile, this.requestTimeoutMs);
    } catch (error) {
      this.stateValue = {
        ...emptyState(),
        status: "error",
        error: { code: "IMPORT_INPUT_ERROR", message: errorMessage(error) },
      };
      return this.state;
    }

    this.stateValue = {
      ...emptyState(),
      status: "loading",
      loading: true,
      inputKind: descriptor.inputKind,
      source: descriptor.source,
      sourceKind: descriptor.sourceKind,
    };

    try {
      const payload = await descriptor.load();
      const config = parseTvBoxConfig(payload);
      const summary = summarizeConfig(config);
      const sites = sitesForUi(config);
      const selectedSite = sites
        .map((site) => findSite(config, site.key))
        .find((site) => isSupportedJvmSite(site));
      const assessment = inspectImport(descriptor.source, config, this.trustStore);

      this.config = config;
      this.assessment = assessment;
      this.selectedSite = selectedSite;
      this.stateValue = {
        ...this.stateValue,
        loading: false,
        summary,
        sites,
        selectedSiteKey: selectedSite ? siteKeyOf(selectedSite) : null,
        selectedApi: selectedSite?.api ?? null,
        trusted: !assessment.requiresConfirmation,
        warning: assessment.requiresConfirmation ? assessment.warning : null,
      };

      if (!selectedSite) {
        this.setError("UNSUPPORTED_SPIDER_ENGINE", "配置中没有可用的 JVM-native 播放或元数据 Spider 站点");
      } else if (assessment.requiresConfirmation) {
        this.stateValue.status = "confirmation_required";
      } else {
        this.createCurrentSession();
        this.stateValue.status = "ready";
      }
    } catch (error) {
      const code = descriptor.inputKind === "url"
        ? "IMPORT_FETCH_ERROR"
        : descriptor.inputKind === "file"
          ? "IMPORT_READ_ERROR"
          : "IMPORT_INVALID_CONFIG";
      this.stateValue = {
        ...this.stateValue,
        status: "error",
        loading: false,
        error: { code, message: errorMessage(error) },
      };
    }

    return this.state;
  }

  public selectSite(siteKey: string): DesktopSpiderImportState {
    if (!this.config) {
      this.setError("IMPORT_NOT_LOADED", "请先导入配置");
      return this.state;
    }
    const site = findSite(this.config, siteKey);
    if (!site) {
      this.setError("IMPORT_SITE_NOT_FOUND", `未找到站点：${siteKey}`);
      return this.state;
    }
    this.selectedSite = site;
    this.stateValue.selectedSiteKey = siteKeyOf(site);
    this.stateValue.selectedApi = site.api ?? null;
    if (!isSupportedJvmSite(site)) {
      this.setError("UNSUPPORTED_SPIDER_ENGINE", "当前 Spike 只支持 JVM-native csp_Douban 或 csp_PlayableFixture");
    } else {
      this.stateValue.error = null;
      this.stateValue.status = this.assessment?.requiresConfirmation ? "confirmation_required" : "ready";
    }
    return this.state;
  }

  public confirm(): DesktopSpiderImportState {
    if (this.stateValue.status === "ready") return this.state;
    if (this.stateValue.status !== "confirmation_required") {
      this.setError("IMPORT_CONFIRMATION_REQUIRED", "当前导入没有等待确认的配置");
      return this.state;
    }
    if (!this.config || !this.assessment || !this.selectedSite || !this.stateValue.source) {
      this.setError("IMPORT_NOT_LOADED", "导入配置不完整");
      return this.state;
    }

    try {
      this.trustStore.trust(this.stateValue.source);
      this.assessment = inspectImport(this.stateValue.source, this.config, this.trustStore);
      this.createCurrentSession();
      this.stateValue.status = "ready";
      this.stateValue.trusted = true;
      this.stateValue.warning = null;
      this.stateValue.error = null;
    } catch (error) {
      this.setError("IMPORT_TRUST_ERROR", errorMessage(error));
    }
    return this.state;
  }

  public async cancel(): Promise<DesktopSpiderImportState> {
    const session = this.currentSession;
    if (session) await session.destroy();
    this.stateValue.status = "cancelled";
    this.stateValue.loading = false;
    this.stateValue.warning = null;
    this.stateValue.error = null;
    return this.state;
  }

  public async close(): Promise<DesktopSpiderImportState> {
    return this.cancel();
  }

  private createCurrentSession(): void {
    if (!this.config || !this.selectedSite || !this.stateValue.source) {
      throw new Error("Imported configuration is not ready to create a Spider session");
    }
    this.currentSession = this.createSession(
      this.stateValue.source,
      this.config,
      this.selectedSite,
    );
  }

  private async releaseCurrentSession(): Promise<void> {
    const session = this.currentSession;
    this.currentSession = undefined;
    if (session) await session.destroy();
  }

  private setError(code: string, message: string): void {
    this.stateValue.status = "error";
    this.stateValue.loading = false;
    this.stateValue.error = { code, message };
  }
}

export function renderDesktopSpiderImportUi(state: DesktopSpiderImportState): string {
  const statusLabel: Record<DesktopSpiderImportStatus, string> = {
    empty: "等待导入",
    loading: "正在读取配置",
    confirmation_required: "等待确认",
    ready: "配置已准备",
    cancelled: "已取消",
    error: "导入失败",
  };
  const summary = state.summary
    ? `<section data-testid="config-summary">
        <strong>配置摘要</strong>
        <p>站点 ${state.summary.siteCount} 个，Spider：${state.summary.hasSpider ? "有" : "无"}</p>
      </section>`
    : "";
  const warning = state.status === "confirmation_required" && state.warning
    ? `<section class="warning" data-testid="import-warning">
        <strong>首次导入需要确认</strong>
        <p>${escapeHtml(state.warning)}</p>
        <button data-action="confirm-import">确认并信任</button>
        <button data-action="cancel-import">取消</button>
      </section>`
    : "";
  const error = state.error
    ? `<section class="error" data-testid="import-error">
        <strong>${escapeHtml(state.error.code)}</strong>
        <p>${escapeHtml(state.error.message)}</p>
      </section>`
    : "";
  const sites = state.sites.length > 0
    ? `<form data-testid="site-selector" data-action="select-site-form">
        <label>Spider 站点
          <select name="siteKey">
            ${state.sites.map((site) => `<option value="${escapeHtml(site.key)}"${site.key === state.selectedSiteKey ? " selected" : ""}>${escapeHtml(site.name)} · ${escapeHtml(site.api)}</option>`).join("")}
          </select>
        </label>
        <button type="submit">选择站点</button>
      </form>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>QX 影视 · 导入配置</title>
    <style>
      :root { font-family: system-ui, sans-serif; color-scheme: light; }
      body { margin: 0; background: #f4f6f8; color: #17202a; }
      main { max-width: 860px; margin: 0 auto; padding: 24px; }
      header, section, form { background: #fff; border: 1px solid #dce1e6; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
      textarea { display: block; box-sizing: border-box; width: 100%; min-height: 140px; margin: 12px 0; font: inherit; }
      button { cursor: pointer; padding: 8px 12px; margin-right: 8px; }
      .warning { border-color: #e3a008; background: #fff8e1; }
      .error { border-color: #d64545; background: #fff1f1; }
      .loading { color: #946200; }
    </style>
  </head>
  <body>
    <main data-testid="config-import-ui" data-status="${escapeHtml(state.status)}">
      <header>
        <h1>导入 TVBox / FongMi 配置</h1>
        <p data-testid="import-status" class="${state.loading ? "loading" : ""}">${escapeHtml(statusLabel[state.status])}${state.loading ? " · 加载中" : ""}</p>
        ${state.source ? `<p>来源：${escapeHtml(state.source)}</p>` : ""}
      </header>
      <form data-testid="config-import-form" data-action="import-form">
        <label for="config-input">粘贴配置 URL、文件路径或原始 JSON</label>
        <textarea id="config-input" name="input" placeholder="https://... / C:\\config.json / {&quot;sites&quot;:[...]}"></textarea>
        <button type="submit"${state.loading ? " disabled" : ""}>导入配置</button>
      </form>
      ${summary}
      ${sites}
      ${warning}
      ${error}
    </main>
    <script>
      (() => {
        const send = async (path, body = {}) => {
          const status = document.querySelector('[data-testid="import-status"]');
          if (status) { status.textContent = '加载中'; status.classList.add('loading'); }
          await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          window.location.reload();
        };
        document.querySelector('[data-action="import-form"]')?.addEventListener('submit', (event) => {
          event.preventDefault();
          const input = new FormData(event.currentTarget).get('input');
          void send('/api/import/load', { input: String(input || '') });
        });
        document.querySelectorAll('[data-action="confirm-import"]').forEach((button) => button.addEventListener('click', () => send('/api/import/confirm')));
        document.querySelectorAll('[data-action="cancel-import"]').forEach((button) => button.addEventListener('click', () => send('/api/import/cancel')));
        document.querySelector('[data-action="select-site-form"]')?.addEventListener('submit', (event) => {
          event.preventDefault();
          const siteKey = new FormData(event.currentTarget).get('siteKey');
          void send('/api/import/select', { siteKey: String(siteKey || '') });
        });
      })();
    </script>
  </body>
</html>`;
}

interface ImportDescriptor {
  inputKind: DesktopSpiderImportInputKind;
  source: string;
  sourceKind: ImportSourceKind;
  load(): Promise<string>;
}

function describeInput(
  input: string,
  fetchText: (url: string, timeoutMs: number) => Promise<string>,
  readFile: (path: string) => string,
  requestTimeoutMs: number,
): ImportDescriptor {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("请输入配置 URL、文件路径或原始 JSON");
  if (/^https?:\/\//i.test(trimmed)) {
    const source = new URL(trimmed).toString();
    return {
      inputKind: "url",
      source,
      sourceKind: "remote",
      load: () => fetchText(source, requestTimeoutMs),
    };
  }
  if (isInlinePayload(trimmed)) {
    const digest = createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 16);
    return {
      inputKind: "json",
      source: `inline:${digest}`,
      sourceKind: "inline",
      load: async () => trimmed,
    };
  }
  const absolutePath = resolve(trimmed);
  const source = pathToFileURL(absolutePath).toString();
  return {
    inputKind: "file",
    source,
    sourceKind: "local",
    load: async () => readFile(absolutePath),
  };
}

async function fetchImportText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} while reading ${url}`);
  return response.text();
}

function isInlinePayload(value: string): boolean {
  return value.startsWith("{")
    || value.startsWith("[")
    || /^tvbox:\/\//i.test(value)
    || value.startsWith("2423")
    || /[A-Za-z0-9]{8}\*\*/.test(value);
}

function sitesForUi(config: TvBoxConfig): DesktopSpiderImportSite[] {
  const sites = Array.isArray(config.sites) ? config.sites : [];
  return sites
    .filter((site) => typeof site.api === "string")
    .map((site) => ({
      key: siteKeyOf(site),
      name: typeof site.name === "string" ? site.name : siteKeyOf(site),
      api: site.api as string,
    }));
}

function findSite(config: TvBoxConfig, siteKey: string): TvBoxSite | undefined {
  const sites = Array.isArray(config.sites) ? config.sites : [];
  return sites.find((site) => site.key === siteKey)
    ?? sites.find((site) => site.api === siteKey);
}

function isSupportedJvmSite(site: TvBoxSite | undefined): site is TvBoxSite & { api: string } {
  return typeof site?.api === "string"
    && routeSpiderApi(site.api) === "java"
    && findJvmSpider(site.api) !== undefined;
}

function siteKeyOf(site: TvBoxSite): string {
  return typeof site.key === "string" && site.key.length > 0
    ? site.key
    : site.api ?? "";
}

function emptyState(): DesktopSpiderImportState {
  return {
    status: "empty",
    loading: false,
    inputKind: null,
    source: null,
    sourceKind: null,
    warning: null,
    error: null,
    trusted: false,
    summary: null,
    sites: [],
    selectedSiteKey: null,
    selectedApi: null,
    sessionReady: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
