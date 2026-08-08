import type { TvBoxConfig, TvBoxSite } from "../config/decoder.js";
import { resolveDesktopSourceBinding, type DesktopSourceBinding } from "./source-router.js";
import type { SourceCapabilities, SourceEngine } from "../source/media-source.js";

export interface SiteManagementPreferences {
  enabled?: boolean;
  searchEnabled?: boolean;
  alias?: string;
  order?: number;
}

export interface ManagedSite {
  key: string;
  name: string;
  alias: string;
  api: string;
  engine: SourceEngine | "unsupported";
  capabilities: SourceCapabilities;
  enabled: boolean;
  searchEnabled: boolean;
  trusted: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
  cacheGeneration: number;
  reinitializeGeneration: number;
}

export interface SiteManagerConfig {
  config: TvBoxConfig;
  sourceUrl?: string;
  trusted?: boolean | ((site: TvBoxSite) => boolean);
  preferences?: Readonly<Record<string, SiteManagementPreferences>>;
}

export class SiteManager {
  private entries: ManagedSite[];

  public constructor(options: SiteManagerConfig) {
    this.entries = buildEntries(options);
  }

  public list(): readonly ManagedSite[] {
    return this.entries.map(cloneSite);
  }

  public get(siteKey: string): ManagedSite | undefined {
    const entry = this.entries.find((site) => site.key === siteKey);
    return entry ? cloneSite(entry) : undefined;
  }

  public setEnabled(siteKey: string, enabled: boolean): ManagedSite {
    const site = this.require(siteKey);
    site.enabled = enabled;
    return cloneSite(site);
  }

  public setSearchEnabled(siteKey: string, enabled: boolean): ManagedSite {
    const site = this.require(siteKey);
    site.searchEnabled = enabled;
    return cloneSite(site);
  }

  public setAlias(siteKey: string, alias: string): ManagedSite {
    const site = this.require(siteKey);
    site.alias = alias.trim() || site.name;
    return cloneSite(site);
  }

  public reorder(siteKeys: readonly string[]): readonly ManagedSite[] {
    const rank = new Map(siteKeys.map((key, index) => [key, index]));
    this.entries.sort((left, right) => {
      const leftRank = rank.get(left.key);
      const rightRank = rank.get(right.key);
      if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
      if (leftRank !== undefined) return -1;
      if (rightRank !== undefined) return 1;
      return left.key.localeCompare(right.key);
    });
    return this.list();
  }

  public setTrusted(siteKey: string, trusted: boolean): ManagedSite {
    const site = this.require(siteKey);
    site.trusted = trusted;
    return cloneSite(site);
  }

  public setCapabilities(siteKey: string, capabilities: SourceCapabilities): ManagedSite {
    const site = this.require(siteKey);
    site.capabilities = { ...capabilities };
    return cloneSite(site);
  }

  public recordSuccess(siteKey: string, at = Date.now()): ManagedSite {
    const site = this.require(siteKey);
    site.lastSuccessAt = at;
    site.lastError = null;
    return cloneSite(site);
  }

  public recordError(siteKey: string, error: string): ManagedSite {
    const site = this.require(siteKey);
    site.lastError = error;
    return cloneSite(site);
  }

  public clearCache(siteKey: string): ManagedSite {
    const site = this.require(siteKey);
    site.cacheGeneration += 1;
    return cloneSite(site);
  }

  public reinitialize(siteKey: string): ManagedSite {
    const site = this.require(siteKey);
    site.reinitializeGeneration += 1;
    site.lastError = null;
    return cloneSite(site);
  }

  public searchable(): readonly ManagedSite[] {
    return this.entries
      .filter((site) => site.enabled && site.searchEnabled && site.capabilities.search)
      .map(cloneSite);
  }

  public playbackAvailable(siteKey: string): boolean {
    const site = this.get(siteKey);
    return Boolean(site?.enabled && site.capabilities.playback);
  }

  public preferences(): Readonly<Record<string, SiteManagementPreferences>> {
    return Object.fromEntries(this.entries.map((site, order) => [site.key, {
      enabled: site.enabled,
      searchEnabled: site.searchEnabled,
      alias: site.alias,
      order,
    }]));
  }

  private require(siteKey: string): ManagedSite {
    const site = this.entries.find((candidate) => candidate.key === siteKey);
    if (!site) throw new Error(`Site not found: ${siteKey}`);
    return site;
  }
}

function buildEntries(options: SiteManagerConfig): ManagedSite[] {
  const sites = Array.isArray(options.config.sites) ? options.config.sites : [];
  const trusted: (site: TvBoxSite) => boolean = typeof options.trusted === "function"
    ? options.trusted
    : () => options.trusted === true;
  return sites
    .filter((site): site is TvBoxSite & { api: string } => typeof site.api === "string")
    .map((site, index) => {
      const key = siteKeyOf(site);
      const binding = resolveDesktopSourceBinding(options.config, site, options.sourceUrl);
      const engine: ManagedSite["engine"] = binding?.engine ?? "unsupported";
      const preference = options.preferences?.[key];
      return {
        key,
        name: typeof site.name === "string" && site.name.length > 0 ? site.name : key,
        alias: preference?.alias?.trim() || (typeof site.name === "string" && site.name.length > 0 ? site.name : key),
        api: site.api,
        engine,
        capabilities: binding?.capabilities ?? unsupportedCapabilities(),
        enabled: preference?.enabled ?? true,
        searchEnabled: preference?.searchEnabled ?? true,
        trusted: trusted(site),
        lastSuccessAt: null,
        lastError: null,
        cacheGeneration: 0,
        reinitializeGeneration: 0,
        order: preference?.order ?? index,
        explicitOrder: preference?.order !== undefined,
      };
    })
    .sort((left, right) => Number(right.explicitOrder) - Number(left.explicitOrder) || left.order - right.order)
    .map(({ order: _order, explicitOrder: _explicitOrder, ...site }) => site);
}

function cloneSite(site: ManagedSite): ManagedSite {
  return { ...site, capabilities: { ...site.capabilities } };
}

function siteKeyOf(site: TvBoxSite): string {
  return typeof site.key === "string" && site.key.length > 0 ? site.key : site.api ?? "";
}

function unsupportedCapabilities(): SourceCapabilities {
  return {
    home: false,
    category: false,
    search: false,
    detail: false,
    playback: false,
    localProxy: false,
    filters: false,
    pagination: false,
    engine: "fixture",
  };
}
