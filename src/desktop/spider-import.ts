import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  parseTvBoxConfig,
  summarizeConfig,
  type ConfigSummary,
  type TvBoxConfig,
  type TvBoxSite,
} from "../config/decoder.js";
import {
  ConfigHistoryStore,
  type ConfigChangeSummary,
  type ConfigRefreshLoader,
  type ConfigVersion,
} from "../config/history.js";
import { ConfigRefreshManager, type ConfigRefreshOutcome } from "../config/refresh.js";
import type { SourceCapabilities } from "../source/media-source.js";
import type { SearchRequest, VodPage } from "../source/media-source.js";
import { normalizeVodDetails, normalizeVodPage, unwrapSpiderResponse } from "../source/normalizers.js";
import {
  AggregateSearchCoordinator,
  type AggregateSearchOptions,
  type AggregateSearchSnapshot,
} from "../search/aggregate-search.js";
import { SourceHealthRegistry, type SourceHealthSnapshot } from "../health/source-health.js";
import {
  ImportTrustStore,
  inspectImportAsync,
  type ImportAssessment,
  type ImportSourceKind,
} from "../config/trust.js";
import { SiteManager, type ManagedSite } from "./site-management.js";
import { resolveDesktopSourceBinding } from "./source-router.js";
import type { DesktopSpiderSessionPort } from "./spider-ui.js";
import {
  PlaybackSourceResolver,
  type PlaybackSourceEngine,
  type PlaybackSourceSite,
  type PlaybackSourceResolution,
  type PlaybackSourceResolverOptions,
  type SourceEngineFactory,
} from "./playback-source-resolver.js";
import type { Vod } from "../source/media-source.js";
import { normalizeFongMiSite, serializeFongMiExt } from "../config/fongmi.js";
import { SpiderRuntimeManager } from "../spider/spider-runtime.js";
import type { SpiderRuntimeManagerPort } from "../spider/runtime-types.js";

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
  alias: string;
  api: string;
  engine: ManagedSite["engine"];
  capabilities: SourceCapabilities;
  enabled: boolean;
  searchEnabled: boolean;
  trusted: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
  health: SourceHealthSnapshot;
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
  refresh: DesktopSpiderRefreshState;
  trust: DesktopSpiderTrustSummary | null;
}

export interface DesktopSpiderRefreshState {
  enabled: boolean;
  running: boolean;
  pendingVersionId: string | null;
  pendingChange: ConfigChangeSummary | null;
  lastError: string | null;
}

export interface DesktopSpiderTrustSummary {
  source: string;
  configHash: string;
  engines: readonly string[];
  spiderSources: readonly string[];
  spiderHashes: Readonly<Record<string, string>>;
  allowedDomains: readonly string[];
  executesCode: boolean;
  usesCookie: boolean;
  requestsLocalService: boolean;
  fileChanged: boolean;
  lastTrustedAt: number | null;
}

export interface DesktopSpiderImportOptions {
  trustStore: ImportTrustStore;
  createSession: (
    source: string,
    config: TvBoxConfig,
    site: TvBoxSite,
    assessment?: ImportAssessment,
    health?: SourceHealthRegistry,
  ) => DesktopSpiderSessionPort;
  preferredSiteKey?: () => string | null;
  fetchText?: (url: string, timeoutMs: number) => Promise<string>;
  readFile?: (path: string) => string;
  history?: ConfigHistoryStore;
  autoRefresh?: boolean;
  refreshIntervalMs?: number;
  fetchRefresh?: ConfigRefreshLoader;
  requestTimeoutMs?: number;
  runtimeManager?: SpiderRuntimeManagerPort;
  runtimeManagerFactory?: (config: TvBoxConfig, sourceUrl?: string) => SpiderRuntimeManagerPort;
}

export class DesktopSpiderImportController {
  private readonly trustStore: ImportTrustStore;
  private readonly createSession: DesktopSpiderImportOptions["createSession"];
  private readonly preferredSiteKey: (() => string | null) | undefined;
  private readonly fetchText: (url: string, timeoutMs: number) => Promise<string>;
  private readonly readFile: (path: string) => string;
  private readonly history: ConfigHistoryStore | undefined;
  private readonly refreshManager: ConfigRefreshManager | undefined;
  private readonly autoRefresh: boolean;
  private readonly fetchRefresh: ConfigRefreshLoader | undefined;
  private readonly requestTimeoutMs: number;
  private readonly runtimeManager: SpiderRuntimeManagerPort | undefined;
  private readonly runtimeManagerFactory: DesktopSpiderImportOptions["runtimeManagerFactory"];
  private activeRuntimeManager: SpiderRuntimeManagerPort | undefined;
  private runtimeExecutionEnabled = false;
  private currentSession: DesktopSpiderSessionPort | undefined;
  private readonly sessions = new Map<string, DesktopSpiderSessionPort>();
  private config: TvBoxConfig | undefined;
  private assessment: ImportAssessment | undefined;
  private selectedSite: TvBoxSite | undefined;
  private siteManager: SiteManager | undefined;
  private aggregateCoordinator: AggregateSearchCoordinator | undefined;
  private readonly playbackSourceResolver = new PlaybackSourceResolver();
  private readonly health = new SourceHealthRegistry();
  private readonly openingSessions = new Map<string, Promise<void>>();
  private readonly initializationFailures = new Set<string>();
  private currentSessionKey: string | undefined;
  private lastRefreshError: string | null = null;
  private refreshRequestSource: string | undefined;
  private stateValue: DesktopSpiderImportState = emptyState();

  public constructor(options: DesktopSpiderImportOptions) {
    this.trustStore = options.trustStore;
    this.createSession = options.createSession;
    this.preferredSiteKey = options.preferredSiteKey;
    this.fetchText = options.fetchText ?? fetchImportText;
    this.readFile = options.readFile ?? ((path) => readFileSync(path, "utf8"));
    this.history = options.history;
    this.autoRefresh = options.autoRefresh === true;
    this.fetchRefresh = options.fetchRefresh;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.runtimeManager = options.runtimeManager;
    this.runtimeManagerFactory = options.runtimeManagerFactory;
    this.refreshManager = this.history
      ? new ConfigRefreshManager(this.history, {
          ...(options.refreshIntervalMs === undefined ? {} : { intervalMs: options.refreshIntervalMs }),
          spiderHashes: async (config) => {
            const source = this.stateValue.source;
            if (!source) return {};
            return (await inspectImportAsync(source, config, this.trustStore, {
              fetchText: (url) => this.fetchText(url, this.requestTimeoutMs),
            })).spiderHashes;
          },
          onApply: (config, version) => this.applyRefreshedConfig(config, version),
        })
      : undefined;
  }

  public get state(): DesktopSpiderImportState {
    const currentSites = this.config && this.siteManager
      ? sitesForUi(this.config, this.siteManager, this.health)
      : this.stateValue.sites;
    return {
      ...this.stateValue,
      summary: this.stateValue.summary
        ? { ...this.stateValue.summary, engineCounts: { ...this.stateValue.summary.engineCounts } }
        : null,
      sites: currentSites.map((site) => ({
        ...site,
        capabilities: { ...site.capabilities },
        health: {
          ...site.health,
          operations: Object.fromEntries(
            Object.entries(site.health.operations).map(([key, value]) => [key, { ...value }]),
          ) as SourceHealthSnapshot["operations"],
        },
      })),
      sessionReady: this.currentSession !== undefined
        && this.currentSession.view.status !== "destroyed",
      refresh: this.refreshState(),
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

  public siteManagement(): readonly DesktopSpiderImportSite[] {
    return this.state.sites;
  }

  public aggregateSearch(
    query: string,
    options: AggregateSearchOptions = {},
  ): Promise<AggregateSearchSnapshot> {
    if (!this.config || !this.siteManager) {
      return Promise.reject(new Error("Configuration is not ready for aggregate search"));
    }
    this.aggregateCoordinator?.cancel();
    const sources = this.siteManager.list()
      .filter((site) => site.enabled && site.searchEnabled && site.engine !== "unsupported")
      .map((site) => ({
        id: site.key,
        label: site.alias,
        search: async (request: SearchRequest): Promise<VodPage> => {
          const session = await this.ensureSiteSession(site.key);
          if (session.capabilities && !session.capabilities.search) {
            throw new Error(`Search is not supported by source: ${site.key}`);
          }
          const response = await session.searchContent(
            request.key,
            request.quick ?? false,
            request.page ?? 1,
          );
          return normalizeVodPage(unwrapSpiderResponse(response, "search"), request.page ?? 1);
        },
      }));
    const coordinator = new AggregateSearchCoordinator(sources);
    this.aggregateCoordinator = coordinator;
    return coordinator.search(query, { ...options, health: this.health });
  }

  public cancelAggregateSearch(): AggregateSearchSnapshot | undefined {
    return this.aggregateCoordinator?.cancel();
  }

  public async resolvePlaybackSources(
    currentVod: Vod,
    options: PlaybackSourceResolverOptions = {},
  ): Promise<PlaybackSourceResolution> {
    if (!this.config || !this.siteManager) {
      return Promise.reject(new Error("Configuration is not ready for playback source search"));
    }
    const currentSiteKey = options.currentSiteKey ?? this.selectedSiteKey;
    const configuredSites = Array.isArray(this.config.sites) ? this.config.sites : [];
    const runtimeManager = this.runtimeManager
      ?? this.activeRuntimeManager
      ?? this.runtimeManagerFactory?.(this.config, this.stateValue.source ?? undefined)
      ?? new SpiderRuntimeManager({
        config: this.config,
        ...(this.stateValue.source ? { sourceUrl: this.stateValue.source } : {}),
      });
    this.activeRuntimeManager = runtimeManager;
    this.runtimeExecutionEnabled = this.runtimeManager !== undefined || this.runtimeManagerFactory !== undefined;
    const sites: PlaybackSourceSite[] = (await Promise.all(configuredSites.map(async (configured, index) => {
      if (typeof configured.api !== "string") return [];
      const siteKey = siteKeyOf(configured) || `site-${index + 1}`;
      const managed = this.siteManager?.get(siteKey);
      const binding = resolveDesktopSourceBinding(this.config!, configured, this.stateValue.source ?? undefined);
      const support = await runtimeManager.supports(configured);
      const resolverCapabilities = {
        search: support.capabilities.search,
        detail: support.capabilities.detail,
      };
      const runtimeSupported = support.supported && resolverCapabilities.search && resolverCapabilities.detail;
      const metadataOnly = knownMetadataOnlySite(siteKey, configured.api);
      const enabled = managed?.enabled !== false
        && managed?.trusted !== false
        && this.health.canRun(siteKey);
      const normalized = normalizeFongMiSite(configured, this.stateValue.source ?? undefined, index);
      const skipReason = !runtimeSupported
        ? support.reason
        : binding === undefined
          ? unsupportedRuntimeReason(normalized.type, configured.api)
        : !enabled
          ? (managed?.enabled === false ? "site_disabled" : "source_health_circuit_open")
          : undefined;
      return [{
        siteKey,
        siteName: managed?.alias ?? normalized.name,
        type: normalized.type,
        api: configured.api,
        ...(configured.ext === undefined ? {} : { ext: serializeFongMiExt(configured.ext) }),
        enabled,
        searchable: configured.searchable === undefined ? true : configured.searchable,
        quickSearch: configured.quickSearch === undefined ? false : configured.quickSearch,
        supported: runtimeSupported && binding !== undefined,
        runtime: support.runtime,
        runtimeReason: support.reason,
        capabilities: resolverCapabilities,
        engine: binding?.engine ?? null,
        ...(skipReason ? { skipReason } : {}),
        metadataOnly,
        ...(managed?.capabilities.playback === undefined ? {} : { playback: managed.capabilities.playback }),
      } satisfies PlaybackSourceSite];
    }))).flat();
    const engineFactory: SourceEngineFactory = {
      create: (site) => this.createPlaybackSourceEngine(site),
    };
    return this.playbackSourceResolver.resolve(currentVod, sites, {
      ...options,
      configSiteCount: configuredSites.length,
      engineFactory,
      ...(currentSiteKey === null ? {} : { currentSiteKey }),
    });
  }

  public async refreshConfiguration(): Promise<DesktopSpiderImportState> {
    const source = this.stateValue.source;
    const inputKind = this.stateValue.inputKind;
    if (!this.refreshManager || !source || !inputKind) {
      this.setError("CONFIG_REFRESH_UNAVAILABLE", "当前配置没有可用的刷新来源");
      return this.state;
    }
    try {
      const outcome = await this.refreshManager.refresh(
        source,
        historyKindFor(inputKind),
        this.refreshLoader(source, inputKind, this.refreshRequestSource),
      );
      this.lastRefreshError = outcome.result.error;
      if (outcome.requiresApproval) {
        this.stateValue.warning = refreshChangeWarning(outcome);
      } else if (outcome.result.error) {
        this.stateValue.warning = outcome.result.usedCache
          ? "远程配置刷新失败，继续使用最后成功版本。"
          : outcome.result.error;
      } else if (outcome.result.changed) {
        this.stateValue.warning = null;
      }
    } catch (error) {
      this.lastRefreshError = errorMessage(error);
      this.stateValue.warning = this.lastRefreshError;
      this.setError("CONFIG_REFRESH_ERROR", this.lastRefreshError);
    }
    return this.state;
  }

  public async approveConfigurationRefresh(versionId?: string): Promise<DesktopSpiderImportState> {
    if (!this.refreshManager || !this.stateValue.source) {
      this.setError("CONFIG_REFRESH_UNAVAILABLE", "当前配置没有可用的刷新来源");
      return this.state;
    }
    try {
      await this.refreshManager.approve(this.stateValue.source, versionId);
      this.lastRefreshError = null;
      this.stateValue.warning = null;
    } catch (error) {
      this.lastRefreshError = errorMessage(error);
      this.setError("CONFIG_REFRESH_APPROVE_ERROR", this.lastRefreshError);
    }
    return this.state;
  }

  public rejectConfigurationRefresh(): DesktopSpiderImportState {
    if (this.refreshManager && this.stateValue.source) {
      this.refreshManager.reject(this.stateValue.source);
      this.lastRefreshError = null;
      this.stateValue.warning = null;
    }
    return this.state;
  }

  public retrySite(siteKey: string): DesktopSpiderImportState {
    try {
      this.siteManager?.get(siteKey) ?? this.siteManagerRequired();
      this.health.retry(siteKey);
      this.syncManagedSites();
    } catch (error) {
      this.setError("SITE_HEALTH_ERROR", errorMessage(error));
    }
    return this.state;
  }

  public setSiteEnabled(siteKey: string, enabled: boolean): DesktopSpiderImportState {
    try {
      this.siteManager?.setEnabled(siteKey, enabled) ?? this.siteManagerRequired();
      this.syncManagedSites();
    } catch (error) {
      this.setError("SITE_MANAGEMENT_ERROR", errorMessage(error));
    }
    return this.state;
  }

  public setSiteSearchEnabled(siteKey: string, enabled: boolean): DesktopSpiderImportState {
    try {
      this.siteManager?.setSearchEnabled(siteKey, enabled) ?? this.siteManagerRequired();
      this.syncManagedSites();
    } catch (error) {
      this.setError("SITE_MANAGEMENT_ERROR", errorMessage(error));
    }
    return this.state;
  }

  public setSiteAlias(siteKey: string, alias: string): DesktopSpiderImportState {
    try {
      this.siteManager?.setAlias(siteKey, alias) ?? this.siteManagerRequired();
      this.syncManagedSites();
    } catch (error) {
      this.setError("SITE_MANAGEMENT_ERROR", errorMessage(error));
    }
    return this.state;
  }

  public reorderSites(siteKeys: readonly string[]): DesktopSpiderImportState {
    try {
      this.siteManager?.reorder(siteKeys) ?? this.siteManagerRequired();
      this.syncManagedSites();
    } catch (error) {
      this.setError("SITE_MANAGEMENT_ERROR", errorMessage(error));
    }
    return this.state;
  }

  public clearSiteCache(siteKey: string): DesktopSpiderImportState {
    try {
      this.siteManager?.clearCache(siteKey) ?? this.siteManagerRequired();
      this.syncManagedSites();
    } catch (error) {
      this.setError("SITE_MANAGEMENT_ERROR", errorMessage(error));
    }
    return this.state;
  }

  public async reinitializeSite(siteKey: string): Promise<DesktopSpiderImportState> {
    try {
      this.siteManager?.reinitialize(siteKey) ?? this.siteManagerRequired();
      await this.releaseSiteSession(siteKey);
      if (this.selectedSite && siteKeyOf(this.selectedSite) === siteKey) {
        if (this.stateValue.status === "ready") this.createCurrentSession();
      }
      this.syncManagedSites();
    } catch (error) {
      this.setError("SITE_MANAGEMENT_ERROR", errorMessage(error));
    }
    return this.state;
  }

  public async import(input: string): Promise<DesktopSpiderImportState> {
    this.refreshManager?.stop();
    this.lastRefreshError = null;
    this.refreshRequestSource = undefined;
    await this.releaseAllSessions();
    this.config = undefined;
    this.assessment = undefined;
    this.selectedSite = undefined;
    this.siteManager = undefined;
    this.aggregateCoordinator?.cancel();
    this.aggregateCoordinator = undefined;
    this.openingSessions.clear();
    this.initializationFailures.clear();

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
    this.refreshRequestSource = descriptor.requestSource;

    try {
      const payload = await descriptor.load();
      await this.applyPayload(descriptor, payload);
    } catch (error) {
      const cached = this.history?.cached(descriptor.source);
      if (cached) {
        try {
          await this.applyPayload(descriptor, cached.rawJson, true);
          return this.state;
        } catch {
          // Preserve the original error when the cached payload is invalid too.
        }
      }
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

  private async applyPayload(
    descriptor: ImportDescriptor,
    payload: string,
    fromCache = false,
  ): Promise<void> {
    const config = parseTvBoxConfig(payload);
    const summary = summarizeConfig(config);
    const configuredSites = (Array.isArray(config.sites) ? config.sites : [])
      .filter((site) => typeof site.api === "string");
    const sourceUrl = descriptor.requestSource ?? descriptor.source;
    const preferredSiteKey = this.preferredSiteKey?.();
    const selectedSite = configuredSites
      .find((site) => site && siteKeyOf(site) === preferredSiteKey && isSupportedDesktopSite(config, site, sourceUrl))
      ?? configuredSites.find((site) => isSupportedDesktopSite(config, site, sourceUrl));
    const assessment = await inspectImportAsync(descriptor.source, config, this.trustStore, {
      fetchText: (url) => this.fetchText(url, this.requestTimeoutMs),
    });
    this.history?.recordSuccessful(
      descriptor.source,
      historyKindFor(descriptor.inputKind),
      payload,
      {},
      assessment.spiderHashes,
    );
    this.siteManager = new SiteManager({
      config,
      sourceUrl,
      trusted: !assessment.requiresConfirmation,
    });
    const sites = sitesForUi(config, this.siteManager, this.health);

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
      trust: trustSummary(assessment),
      warning: assessment.requiresConfirmation
        ? assessment.warning
        : fromCache
          ? "远程配置不可用，已加载最后成功版本。"
          : null,
    };

    if (!selectedSite) {
      this.setError("UNSUPPORTED_SPIDER_ENGINE", "配置中没有可用的媒体来源站点");
    } else if (assessment.requiresConfirmation) {
      this.stateValue.status = "confirmation_required";
    } else {
      this.createCurrentSession();
      this.stateValue.status = "ready";
    }
    if (this.autoRefresh && this.refreshManager
      && (descriptor.inputKind === "url" || descriptor.inputKind === "file")) {
      this.refreshManager.start(
        descriptor.source,
        historyKindFor(descriptor.inputKind),
        this.refreshLoader(descriptor.source, descriptor.inputKind, descriptor.requestSource),
      );
    }
  }

  private async applyRefreshedConfig(config: TvBoxConfig, version: ConfigVersion): Promise<void> {
    if (!this.runtimeManager) {
      await this.activeRuntimeManager?.destroy?.();
      this.activeRuntimeManager = undefined;
      this.runtimeExecutionEnabled = false;
    }
    const previousSelectedKey = this.selectedSite ? siteKeyOf(this.selectedSite) : this.currentSessionKey;
    const preferences = this.siteManager?.preferences();
    const assessment = await inspectImportAsync(version.source, config, this.trustStore, {
      fetchText: (url) => this.fetchText(url, this.requestTimeoutMs),
    });
    const configuredSites = (Array.isArray(config.sites) ? config.sites : [])
      .filter((site) => typeof site.api === "string");
    const sourceUrl = version.source;
    const selectedSite = configuredSites
      .find((site) => siteKeyOf(site) === previousSelectedKey && isSupportedDesktopSite(config, site, sourceUrl))
      ?? configuredSites.find((site) => isSupportedDesktopSite(config, site, sourceUrl));
    this.config = config;
    this.assessment = assessment;
    this.selectedSite = selectedSite;
    this.siteManager = new SiteManager({
      config,
      sourceUrl,
      trusted: !assessment.requiresConfirmation,
      ...(preferences ? { preferences } : {}),
    });
    this.stateValue = {
      ...this.stateValue,
      summary: summarizeConfig(config),
      sites: sitesForUi(config, this.siteManager, this.health),
      selectedSiteKey: selectedSite ? siteKeyOf(selectedSite) : null,
      selectedApi: selectedSite?.api ?? null,
      trusted: !assessment.requiresConfirmation,
      trust: trustSummary(assessment),
      warning: assessment.requiresConfirmation ? assessment.warning : null,
      error: null,
    };
    if (!selectedSite) {
      this.setError("UNSUPPORTED_SPIDER_ENGINE", "刷新后的配置没有可用来源");
    } else if (assessment.requiresConfirmation) {
      this.stateValue.status = "confirmation_required";
    } else {
      if (!this.currentSession || this.currentSessionKey !== siteKeyOf(selectedSite)) {
        this.createCurrentSession();
      }
      this.stateValue.status = "ready";
    }
  }

  private refreshLoader(
    source: string,
    inputKind: DesktopSpiderImportInputKind,
    requestSource = source,
  ): ConfigRefreshLoader {
    if (this.fetchRefresh) return this.fetchRefresh;
    if (inputKind === "url") {
      return (validators) => fetchConfigPayload(requestSource, this.requestTimeoutMs, validators);
    }
    if (inputKind === "file") {
      return async () => ({ body: this.readFile(fileURLToPath(source)) });
    }
    return async () => {
      throw new Error("Inline JSON configuration cannot be refreshed automatically");
    };
  }

  private refreshState(): DesktopSpiderRefreshState {
    const pending = this.refreshManager && this.stateValue.source
      ? this.refreshManager.pending(this.stateValue.source)
      : null;
    return {
      enabled: this.refreshManager !== undefined,
      running: this.refreshManager?.isRunning ?? false,
      pendingVersionId: pending?.id ?? null,
      pendingChange: pending ? cloneChange(pending.change) : null,
      lastError: this.lastRefreshError,
    };
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
    if (this.siteManager?.get(siteKey)?.enabled === false) {
      this.setError("SITE_DISABLED", `站点已禁用：${siteKey}`);
      return this.state;
    }
    this.selectedSite = site;
    this.stateValue.selectedSiteKey = siteKeyOf(site);
    this.stateValue.selectedApi = site.api ?? null;
    if (!isSupportedDesktopSite(this.config, site, this.stateValue.source ?? undefined)) {
      this.setError("UNSUPPORTED_SPIDER_ENGINE", "当前站点没有可用的来源引擎绑定");
    } else {
      this.stateValue.error = null;
      this.stateValue.status = this.assessment?.requiresConfirmation ? "confirmation_required" : "ready";
      if (this.stateValue.status === "ready") this.createCurrentSession();
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
      this.trustStore.trustAssessment(this.assessment);
      this.assessment = {
        ...this.assessment,
        requiresConfirmation: false,
        lastTrustedAt: Date.now(),
      };
      this.stateValue.trust = trustSummary(this.assessment);
      for (const site of this.siteManager?.list() ?? []) this.siteManager?.setTrusted(site.key, true);
      this.syncManagedSites();
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
    this.refreshManager?.stop();
    await this.releaseAllSessions(true);
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
    const key = siteKeyOf(this.selectedSite);
    const existing = this.sessions.get(key);
    if (existing && existing.view.status !== "destroyed") {
      this.currentSession = existing;
      this.currentSessionKey = key;
      return;
    }
    const session = this.createSession(
      this.stateValue.source,
      this.config,
      this.selectedSite,
      this.assessment,
      this.health,
    );
    this.sessions.set(key, session);
    this.currentSession = session;
    this.currentSessionKey = key;
  }

  private async ensureSiteSession(siteKey: string): Promise<DesktopSpiderSessionPort> {
    if (!this.config || !this.stateValue.source) {
      throw new Error("Configuration is not ready for site search");
    }
    const site = findSite(this.config, siteKey);
    if (!site) throw new Error(`站点不存在：${siteKey}`);
    let session = this.sessions.get(siteKey);
    if (!session || session.view.status === "destroyed") {
      session = this.createSession(this.stateValue.source, this.config, site, this.assessment, this.health);
      this.sessions.set(siteKey, session);
    }
    if (session.view.status !== "ready") {
      const existingOpen = this.openingSessions.get(siteKey);
      if (existingOpen) {
        await existingOpen;
      } else {
        const opening = (async () => {
          const response = await session?.open(siteKey, typeof site.ext === "string" ? site.ext : "");
          if (!response?.ok) {
            throw new Error(response?.error?.message ?? `站点初始化失败：${siteKey}`);
          }
          const capabilities = session?.capabilities;
          if (capabilities && this.siteManager) {
            this.siteManager.setCapabilities(siteKey, capabilities);
            this.syncManagedSites();
          }
        })().finally(() => {
          this.openingSessions.delete(siteKey);
        });
        this.openingSessions.set(siteKey, opening);
        try {
          await opening;
          this.initializationFailures.delete(siteKey);
        } catch (error) {
          this.initializationFailures.add(siteKey);
          throw error;
        }
      }
    }
    return session;
  }

  private createPlaybackSourceEngine(site: PlaybackSourceSite): PlaybackSourceEngine {
    const runtimeManager = this.activeRuntimeManager;
    const configured = this.config ? findSite(this.config, site.siteKey) : undefined;
    if (this.runtimeExecutionEnabled && runtimeManager && configured) {
      let runtimePromise: Promise<import("../spider/runtime-types.js").SpiderRuntime> | undefined;
      const getRuntime = async () => {
        runtimePromise ??= runtimeManager.getRuntime(configured);
        const runtime = await runtimePromise;
        if (runtime.kind === "android-dex" || runtime.kind === "unsupported") {
          throw new Error(site.skipReason ?? "unsupported_runtime");
        }
        if (!runtime.capabilities.search || !runtime.capabilities.detail) {
          throw new Error("runtime_capability_missing");
        }
        return runtime;
      };
      let initialized = false;
      return {
        init: async () => {
          if (initialized) return;
          const runtime = await getRuntime();
          await runtime.init(configured, {
            sourceId: this.stateValue.source ?? `runtime:${site.siteKey}`,
            siteKey: site.siteKey,
            ...(site.ext === undefined ? {} : { ext: site.ext }),
          });
          initialized = true;
        },
        search: async (query, quick, page) => (await (await getRuntime()).search({ key: query, quick, page })).items,
        detail: async (vodId) => (await (await getRuntime()).detail([vodId]))[0] ?? null,
      };
    }
    let session: DesktopSpiderSessionPort | undefined;
    const ensure = async (): Promise<DesktopSpiderSessionPort> => {
      session ??= await this.ensureSiteSession(site.siteKey);
      return session;
    };
    return {
      init: async () => {
        await ensure();
      },
      search: async (query, quick, page) => {
        const active = await ensure();
        const response = await active.searchContent(query, quick, page);
        return normalizeVodPage(unwrapSpiderResponse(response, "search"), page).items;
      },
      detail: async (vodId) => {
        const active = await ensure();
        const response = await active.detailContent([vodId]);
        return normalizeVodDetails(unwrapSpiderResponse(response, "detail"))[0] ?? null;
      },
    };
  }

  private async releaseSiteSession(siteKey: string): Promise<void> {
    const session = this.sessions.get(siteKey);
    this.sessions.delete(siteKey);
    this.initializationFailures.delete(siteKey);
    if (this.currentSession === session) {
      this.currentSession = undefined;
      this.currentSessionKey = undefined;
    }
    if (session) await session.destroy();
  }

  private async releaseAllSessions(retainCurrent = false): Promise<void> {
    const previousCurrent = this.currentSession;
    const previousCurrentKey = this.currentSessionKey;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.currentSession = undefined;
    this.currentSessionKey = undefined;
    await Promise.all(sessions.map((session) => session.destroy()));
    if (!retainCurrent && !this.runtimeManager) {
      await this.activeRuntimeManager?.destroy?.();
      this.activeRuntimeManager = undefined;
      this.runtimeExecutionEnabled = false;
    }
    if (retainCurrent) {
      this.currentSession = previousCurrent;
      this.currentSessionKey = previousCurrentKey;
    }
  }

  private setError(code: string, message: string): void {
    this.stateValue.status = "error";
    this.stateValue.loading = false;
    this.stateValue.error = { code, message };
  }

  private syncManagedSites(): void {
    if (!this.config || !this.siteManager) return;
    this.stateValue.sites = sitesForUi(this.config, this.siteManager, this.health);
  }

  private siteManagerRequired(): never {
    throw new Error("Site management is unavailable before configuration import");
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
  const trust = state.trust
    ? `<section data-testid="trust-summary">
        <strong>来源信任摘要</strong>
        <p>配置来源：${escapeHtml(state.trust.source)}</p>
        <p>引擎：${escapeHtml(state.trust.engines.join(", ") || "无")}</p>
        <p>执行代码：${state.trust.executesCode ? "是" : "否"} · Cookie：${state.trust.usesCookie ? "是" : "否"} · 本地服务：${state.trust.requestsLocalService ? "是" : "否"}</p>
        <p>允许域名：${escapeHtml(state.trust.allowedDomains.join(", ") || "未声明")}</p>
        <p>配置哈希：${escapeHtml(state.trust.configHash)} · 文件变化：${state.trust.fileChanged ? "是" : "否"} · 上次信任：${state.trust.lastTrustedAt === null ? "从未" : String(state.trust.lastTrustedAt)}</p>
        <p>Spider 来源：${escapeHtml(state.trust.spiderSources.join(", ") || "无")}</p>
        <p>Spider 哈希：${escapeHtml(Object.entries(state.trust.spiderHashes).map(([source, hash]) => `${source}=${hash}`).join(" · ") || "无")}</p>
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
            ${state.sites.map((site) => `<option value="${escapeHtml(site.key)}"${site.key === state.selectedSiteKey ? " selected" : ""}${site.enabled ? "" : " disabled"}>${escapeHtml(site.name)} · ${escapeHtml(site.api)} · ${escapeHtml(site.engine)}</option>`).join("")}
          </select>
        </label>
        <button type="submit">选择站点</button>
      </form>`
    : "";
  const siteManagement = state.sites.length > 0
    ? `<section data-testid="site-management">
        <strong>站点管理</strong>
        ${state.sites.map((site) => `<article data-site-key="${escapeHtml(site.key)}">
          <p><strong>${escapeHtml(site.alias)}</strong> · ${escapeHtml(site.engine)} · ${escapeHtml(site.trusted ? "已信任" : "未信任")}</p>
          <label><input type="checkbox" data-action="site-enabled" data-site-key="${escapeHtml(site.key)}"${site.enabled ? " checked" : ""}>启用</label>
          <label><input type="checkbox" data-action="site-search" data-site-key="${escapeHtml(site.key)}"${site.searchEnabled ? " checked" : ""}>参与搜索</label>
          <label>别名 <input data-action="site-alias" data-site-key="${escapeHtml(site.key)}" value="${escapeHtml(site.alias)}"></label>
          <span>能力：${escapeHtml(capabilityLabels(site.capabilities))}</span>
          <span>健康：${escapeHtml(site.health.circuit)} · 连续失败 ${site.health.consecutiveFailures} · 超时 ${site.health.timeoutCount} · 崩溃 ${site.health.sidecarCrashCount}</span>
          <button type="button" data-action="site-move-up" data-site-key="${escapeHtml(site.key)}">上移</button>
          <button type="button" data-action="site-move-down" data-site-key="${escapeHtml(site.key)}">下移</button>
          <button type="button" data-action="site-reinitialize" data-site-key="${escapeHtml(site.key)}">重新初始化</button>
          <button type="button" data-action="site-clear-cache" data-site-key="${escapeHtml(site.key)}">清除缓存</button>
          <button type="button" data-action="site-retry" data-site-key="${escapeHtml(site.key)}">手动重试</button>
        </article>`).join("")}
      </section>`
    : "";
  const refresh = state.refresh.enabled
    ? `<section data-testid="config-refresh">
        <strong>配置刷新</strong>
        <p>${state.refresh.running ? "定时刷新已启用" : "可手动检查远程或文件配置"}</p>
        ${state.refresh.pendingVersionId
          ? `<p class="warning">检测到危险变更，需确认后应用。${state.refresh.pendingChange
            ? `新增 ${state.refresh.pendingChange.addedSites.length}，删除 ${state.refresh.pendingChange.removedSites.length}，变更 ${state.refresh.pendingChange.changedSites.length}`
            : ""}</p>
            <button type="button" data-action="refresh-approve" data-version-id="${escapeHtml(state.refresh.pendingVersionId)}">应用刷新</button>
            <button type="button" data-action="refresh-reject">拒绝刷新</button>`
          : ""}
        ${state.refresh.lastError ? `<p class="error">${escapeHtml(state.refresh.lastError)}</p>` : ""}
        <button type="button" data-action="refresh-now">立即刷新</button>
      </section>`
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
      ${trust}
      ${sites}
      ${siteManagement}
      ${refresh}
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
        document.querySelectorAll('[data-action="site-enabled"]').forEach((input) => input.addEventListener('change', (event) => {
          const target = event.currentTarget;
          void send('/api/import/site-enabled', { siteKey: target.dataset.siteKey, enabled: target.checked });
        }));
        document.querySelectorAll('[data-action="site-search"]').forEach((input) => input.addEventListener('change', (event) => {
          const target = event.currentTarget;
          void send('/api/import/site-search', { siteKey: target.dataset.siteKey, enabled: target.checked });
        }));
        document.querySelectorAll('[data-action="site-alias"]').forEach((input) => input.addEventListener('change', (event) => {
          const target = event.currentTarget;
          void send('/api/import/site-alias', { siteKey: target.dataset.siteKey, alias: target.value });
        }));
        document.querySelectorAll('[data-action="site-reinitialize"]').forEach((button) => button.addEventListener('click', () => send('/api/import/site-reinitialize', { siteKey: button.dataset.siteKey })));
        document.querySelectorAll('[data-action="site-clear-cache"]').forEach((button) => button.addEventListener('click', () => send('/api/import/site-clear-cache', { siteKey: button.dataset.siteKey })));
        document.querySelectorAll('[data-action="site-retry"]').forEach((button) => button.addEventListener('click', () => send('/api/import/site-retry', { siteKey: button.dataset.siteKey })));
        const moveSite = (button, offset) => {
          const articles = [...document.querySelectorAll('[data-testid="site-management"] article')];
          const index = articles.indexOf(button.closest('article'));
          const next = index + offset;
          if (index < 0 || next < 0 || next >= articles.length) return;
          const keys = articles.map((article) => article.dataset.siteKey);
          [keys[index], keys[next]] = [keys[next], keys[index]];
          void send('/api/import/site-reorder', { siteKeys: keys });
        };
        document.querySelectorAll('[data-action="site-move-up"]').forEach((button) => button.addEventListener('click', () => moveSite(button, -1)));
        document.querySelectorAll('[data-action="site-move-down"]').forEach((button) => button.addEventListener('click', () => moveSite(button, 1)));
        document.querySelector('[data-action="refresh-now"]')?.addEventListener('click', () => send('/api/import/refresh'));
        document.querySelector('[data-action="refresh-approve"]')?.addEventListener('click', (event) => {
          const button = event.currentTarget;
          void send('/api/import/refresh-approve', { versionId: button.dataset.versionId });
        });
        document.querySelector('[data-action="refresh-reject"]')?.addEventListener('click', () => send('/api/import/refresh-reject'));
      })();
    </script>
  </body>
</html>`;
}

interface ImportDescriptor {
  inputKind: DesktopSpiderImportInputKind;
  source: string;
  sourceKind: ImportSourceKind;
  requestSource?: string;
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
    const requestSource = new URL(trimmed).toString();
    const source = safeSourceForDisplay(requestSource);
    return {
      inputKind: "url",
      source,
      sourceKind: "remote",
      requestSource,
      load: () => fetchText(requestSource, requestTimeoutMs),
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

async function fetchConfigPayload(
  url: string,
  timeoutMs: number,
  validators: { etag: string | null; lastModified: string | null } | null,
): Promise<{ body?: string; notModified?: boolean; etag?: string | null; lastModified?: string | null }> {
  const headers: Record<string, string> = {};
  if (validators?.etag) headers["if-none-match"] = validators.etag;
  if (validators?.lastModified) headers["if-modified-since"] = validators.lastModified;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  if (response.status === 304) return { notModified: true, etag, lastModified };
  if (!response.ok) throw new Error(`HTTP ${response.status} while refreshing configuration`);
  return { body: await response.text(), etag, lastModified };
}

function refreshChangeWarning(outcome: ConfigRefreshOutcome): string {
  const change = outcome.result.version?.change;
  if (!change) return "配置刷新检测到变更，请确认后应用。";
  const parts = [
    change.addedSites.length > 0 ? `新增 ${change.addedSites.length} 个站点` : "",
    change.removedSites.length > 0 ? `删除 ${change.removedSites.length} 个站点` : "",
    change.changedSites.length > 0 ? `变更 ${change.changedSites.length} 个站点` : "",
    change.spiderChanged || change.spiderContentChanged ? "Spider 来源或内容哈希发生变化" : "",
  ].filter(Boolean);
  return `${parts.join("；") || "配置内容发生变化"}，请确认后应用。`;
}

function cloneChange(change: ConfigChangeSummary): ConfigChangeSummary {
  return {
    addedSites: [...change.addedSites],
    removedSites: [...change.removedSites],
    changedSites: [...change.changedSites],
    spiderChanged: change.spiderChanged,
    spiderContentChanged: change.spiderContentChanged ?? false,
    changedTopLevelKeys: [...change.changedTopLevelKeys],
  };
}

function trustSummary(assessment: ImportAssessment): DesktopSpiderTrustSummary {
  return {
    source: safeSourceForDisplay(assessment.source),
    configHash: assessment.configHash,
    engines: [...assessment.engines],
    spiderSources: [...assessment.spiderSources],
    spiderHashes: { ...assessment.spiderHashes },
    allowedDomains: [...assessment.allowedDomains],
    executesCode: assessment.executesCode,
    usesCookie: assessment.usesCookie,
    requestsLocalService: assessment.requestsLocalService,
    fileChanged: assessment.fileChanged,
    lastTrustedAt: assessment.lastTrustedAt,
  };
}

function safeSourceForDisplay(source: string): string {
  try {
    const url = new URL(source);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch {
    // Inline and local source identifiers do not need URL redaction.
  }
  return source;
}

function isInlinePayload(value: string): boolean {
  return value.startsWith("{")
    || value.startsWith("[")
    || /^tvbox:\/\//i.test(value)
    || value.startsWith("2423")
    || /[A-Za-z0-9]{8}\*\*/.test(value);
}

function sitesForUi(
  config: TvBoxConfig,
  manager: SiteManager,
  health: SourceHealthRegistry,
): DesktopSpiderImportSite[] {
  const sites = Array.isArray(config.sites) ? config.sites : [];
  const byKey = new Map(
    sites
      .filter((site) => typeof site.api === "string")
      .map((site) => [siteKeyOf(site), site] as const),
  );
  return manager.list().map((managed) => {
      if (!byKey.has(managed.key)) throw new Error(`Site manager entry is missing: ${managed.key}`);
      return {
        key: managed.key,
        name: managed.name,
        alias: managed.alias,
        api: managed.api,
        engine: managed.engine,
        capabilities: managed.capabilities,
        enabled: managed.enabled,
        searchEnabled: managed.searchEnabled,
        trusted: managed.trusted,
        lastSuccessAt: managed.lastSuccessAt ?? health.get(managed.key).lastSuccessAt,
        lastError: managed.lastError ?? health.get(managed.key).lastError,
        health: health.get(managed.key),
      };
    });
}

function capabilityLabels(capabilities: SourceCapabilities): string {
  return Object.entries(capabilities)
    .filter(([key, value]) => key !== "engine" && value === true)
    .map(([key]) => key)
    .join(", ") || "无";
}

function findSite(config: TvBoxConfig, siteKey: string): TvBoxSite | undefined {
  const sites = Array.isArray(config.sites) ? config.sites : [];
  return sites.find((site) => site.key === siteKey)
    ?? sites.find((site) => site.api === siteKey);
}

function isSupportedDesktopSite(
  config: TvBoxConfig,
  site: TvBoxSite | undefined,
  sourceUrl?: string,
): site is TvBoxSite & { api: string } {
  return site !== undefined && resolveDesktopSourceBinding(config, site, sourceUrl) !== undefined;
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
    refresh: {
      enabled: false,
      running: false,
      pendingVersionId: null,
      pendingChange: null,
      lastError: null,
    },
    trust: null,
  };
}

function historyKindFor(kind: DesktopSpiderImportInputKind): "url" | "file" | "json" {
  return kind;
}

function knownMetadataOnlySite(siteKey: string, api: string): boolean {
  return /douban/i.test(`${siteKey} ${api}`);
}

function unsupportedRuntimeReason(type: number, api: string): string {
  if (type !== 3) return "unsupported_site_type";
  if (/^csp_/i.test(api) || /\.jar(?:$|[?#])/i.test(api)) return "android_dex_runtime_not_available";
  if (/\.m?js(?:$|[?#])/i.test(api) || /^js:/i.test(api)) return "js_runtime_missing";
  if (/\.py(?:$|[?#])/i.test(api) || /^py:/i.test(api)) return "python_runtime_missing";
  return "unsupported_site_type";
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
