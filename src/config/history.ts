import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { parseTvBoxConfig, type TvBoxConfig } from "./decoder.js";

export type ConfigHistorySourceKind = "url" | "file" | "json";

export interface ConfigValidators {
  etag: string | null;
  lastModified: string | null;
}

export interface ConfigChangeSummary {
  addedSites: readonly string[];
  removedSites: readonly string[];
  changedSites: readonly string[];
  spiderChanged: boolean;
  spiderContentChanged: boolean;
  changedTopLevelKeys: readonly string[];
}

export interface ConfigVersion {
  id: string;
  source: string;
  sourceKind: ConfigHistorySourceKind;
  rawJson: string;
  config: TvBoxConfig;
  versionHash: string;
  createdAt: number;
  validators: ConfigValidators;
  spiderHashes: Readonly<Record<string, string>>;
  change: ConfigChangeSummary;
}

export interface ConfigHistoryState {
  versions: readonly ConfigVersion[];
  activeVersionIds: Readonly<Record<string, string>>;
}

export interface ConfigHistoryPersistence {
  read(): ConfigHistoryState;
  write(state: ConfigHistoryState): void;
}

export class JsonFileConfigHistoryPersistence implements ConfigHistoryPersistence {
  public constructor(private readonly path: string) {
  }

  public read(): ConfigHistoryState {
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!isRecord(value) || !Array.isArray(value.versions) || !isRecord(value.activeVersionIds)) {
        throw new Error("Config history must contain versions and activeVersionIds");
      }
      return {
        versions: value.versions as ConfigVersion[],
        activeVersionIds: value.activeVersionIds as Record<string, string>,
      };
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return { versions: [], activeVersionIds: {} };
      throw new Error(`Unable to read config history: ${this.path}`, { cause: error });
    }
  }

  public write(state: ConfigHistoryState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

export interface ConfigRefreshResponse {
  body?: string;
  notModified?: boolean;
  etag?: string | null;
  lastModified?: string | null;
  spiderHashes?: Readonly<Record<string, string>>;
}

export interface ConfigRefreshResult {
  source: string;
  config: TvBoxConfig | null;
  version: ConfigVersion | null;
  usedCache: boolean;
  changed: boolean;
  error: string | null;
}

export type ConfigRefreshLoader =
  (validators: ConfigValidators | null) => Promise<ConfigRefreshResponse | string>;

export type ConfigSpiderHashLoader =
  (config: TvBoxConfig) => Promise<Readonly<Record<string, string>>>;

export class ConfigHistoryStore {
  private readonly maxVersions: number;
  private readonly versionsBySource = new Map<string, ConfigVersion[]>();
  private readonly activeVersionIds = new Map<string, string>();

  public constructor(
    private readonly persistence?: ConfigHistoryPersistence,
    maxVersions = 10,
  ) {
    this.maxVersions = Math.max(1, Math.floor(maxVersions));
    const state = persistence?.read() ?? { versions: [], activeVersionIds: {} };
    for (const version of state.versions) {
      const list = this.versionsBySource.get(version.source) ?? [];
      list.push(cloneVersion(version));
      this.versionsBySource.set(version.source, list);
    }
    for (const [source, id] of Object.entries(state.activeVersionIds)) {
      if (this.findVersion(source, id)) this.activeVersionIds.set(source, id);
    }
  }

  public recordSuccessful(
    source: string,
    sourceKind: ConfigHistorySourceKind,
    rawJson: string,
    validators: Partial<ConfigValidators> = {},
    spiderHashes: Readonly<Record<string, string>> = {},
  ): ConfigVersion {
    // Parse before mutating any state. A corrupt refresh must leave the last
    // successful version intact.
    const config = parseTvBoxConfig(rawJson);
    const previous = this.latestSuccessful(source);
    const versionHash = digest(rawJson);
    const normalizedSpiderHashes = cloneSpiderHashes(spiderHashes);
    const sameVersion = previous !== null
      && previous.versionHash === versionHash
      && sameSpiderHashes(previous.spiderHashes, normalizedSpiderHashes);
    const existing = sameVersion
      ? {
          ...previous,
          spiderHashes: normalizedSpiderHashes,
          validators: {
            etag: validators.etag === undefined ? previous.validators.etag : validators.etag,
            lastModified: validators.lastModified === undefined
              ? previous.validators.lastModified
              : validators.lastModified,
          },
        }
      : {
          id: randomUUID(),
          source,
          sourceKind,
          rawJson,
          config,
          versionHash,
          createdAt: Date.now(),
          validators: {
            etag: validators.etag ?? null,
            lastModified: validators.lastModified ?? null,
          },
          spiderHashes: normalizedSpiderHashes,
          change: diffConfigs(previous?.config, config, previous?.spiderHashes, normalizedSpiderHashes),
        };
    const list = this.versionsBySource.get(source) ?? [];
    if (sameVersion) {
      list[list.length - 1] = cloneVersion(existing);
    } else {
      list.push(cloneVersion(existing));
    }
    while (list.length > this.maxVersions) list.shift();
    this.versionsBySource.set(source, list);
    this.activeVersionIds.set(source, existing.id);
    this.persist();
    return cloneVersion(existing);
  }

  public latestSuccessful(source: string): ConfigVersion | null {
    const list = this.versionsBySource.get(source);
    const last = list?.[list.length - 1];
    return last ? cloneVersion(last) : null;
  }

  public cached(source: string): ConfigVersion | null {
    if (!this.activeVersionIds.has(source)) return null;
    const activeId = this.activeVersionIds.get(source);
    if (activeId) {
      const active = this.findVersion(source, activeId);
      if (active) return cloneVersion(active);
    }
    return this.latestSuccessful(source);
  }

  public setActive(source: string, versionId: string | null): void {
    if (versionId === null) {
      this.activeVersionIds.delete(source);
    } else if (this.findVersion(source, versionId)) {
      this.activeVersionIds.set(source, versionId);
    } else {
      throw new Error(`Config history version not found: ${versionId}`);
    }
    this.persist();
  }

  public versions(source: string): readonly ConfigVersion[] {
    return (this.versionsBySource.get(source) ?? []).map(cloneVersion);
  }

  public sources(): readonly string[] {
    return [...this.versionsBySource.keys()];
  }

  public rollback(source: string, versionId: string): ConfigVersion {
    const version = this.findVersion(source, versionId);
    if (!version) throw new Error(`Config history version not found: ${versionId}`);
    this.activeVersionIds.set(source, versionId);
    this.persist();
    return cloneVersion(version);
  }

  public delete(source: string, versionId?: string): void {
    if (versionId === undefined) {
      this.versionsBySource.delete(source);
      this.activeVersionIds.delete(source);
      this.persist();
      return;
    }
    const list = this.versionsBySource.get(source) ?? [];
    const next = list.filter((version) => version.id !== versionId);
    if (next.length === list.length) return;
    if (next.length === 0) {
      this.versionsBySource.delete(source);
      this.activeVersionIds.delete(source);
    } else {
      this.versionsBySource.set(source, next);
      if (this.activeVersionIds.get(source) === versionId) {
        const fallback = next[next.length - 1];
        if (fallback) this.activeVersionIds.set(source, fallback.id);
      }
    }
    this.persist();
  }

  public async refresh(
    source: string,
    sourceKind: ConfigHistorySourceKind,
    loader: ConfigRefreshLoader,
    spiderHashLoader?: ConfigSpiderHashLoader,
  ): Promise<ConfigRefreshResult> {
    const cached = this.cached(source);
    try {
      const response = await loader(cached?.validators ?? null);
      const normalized = typeof response === "string" ? { body: response } : response;
      if (normalized.notModified || normalized.body === undefined) {
        if (cached) {
          const spiderHashes = normalized.spiderHashes
            ?? (spiderHashLoader ? await spiderHashLoader(cached.config) : cached.spiderHashes);
          const validators: Partial<ConfigValidators> = {};
          if (normalized.etag !== undefined) validators.etag = normalized.etag;
          if (normalized.lastModified !== undefined) validators.lastModified = normalized.lastModified;
          const version = this.recordSuccessful(
            source,
            sourceKind,
            cached.rawJson,
            validators,
            spiderHashes,
          );
          return {
            source,
            config: version.config,
            version,
            usedCache: true,
            changed: version.id !== cached.id,
            error: null,
          };
        }
        return {
          source,
          config: null,
          version: null,
          usedCache: false,
          changed: false,
          error: "Configuration was not modified but no cache exists",
        };
      }
      const validators: Partial<ConfigValidators> = {};
      if (normalized.etag !== undefined) validators.etag = normalized.etag;
      if (normalized.lastModified !== undefined) validators.lastModified = normalized.lastModified;
      const config = parseTvBoxConfig(normalized.body);
      const spiderHashes = normalized.spiderHashes
        ?? (spiderHashLoader ? await spiderHashLoader(config) : {});
      const version = this.recordSuccessful(source, sourceKind, normalized.body, validators, spiderHashes);
      return {
        source,
        config: version.config,
        version,
        usedCache: false,
        changed: cached?.id !== version.id,
        error: null,
      };
    } catch (error) {
      return {
        source,
        config: cached?.config ?? null,
        version: cached,
        usedCache: cached !== null,
        changed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private findVersion(source: string, versionId: string): ConfigVersion | undefined {
    return this.versionsBySource.get(source)?.find((version) => version.id === versionId);
  }

  private persist(): void {
    this.persistence?.write({
      versions: [...this.versionsBySource.values()].flat().map(cloneVersion),
      activeVersionIds: Object.fromEntries(this.activeVersionIds),
    });
  }
}

export function diffConfigs(
  previous: TvBoxConfig | undefined,
  next: TvBoxConfig,
  previousSpiderHashes: Readonly<Record<string, string>> = {},
  nextSpiderHashes: Readonly<Record<string, string>> = {},
): ConfigChangeSummary {
  const beforeSites = siteMap(previous);
  const afterSites = siteMap(next);
  const addedSites = [...afterSites.keys()].filter((key) => !beforeSites.has(key)).sort();
  const removedSites = [...beforeSites.keys()].filter((key) => !afterSites.has(key)).sort();
  const changedSites = [...afterSites.keys()]
    .filter((key) => beforeSites.has(key) && stableJson(beforeSites.get(key)) !== stableJson(afterSites.get(key)))
    .sort();
  const previousTopLevel = previous ? Object.keys(previous) : [];
  const nextTopLevel = Object.keys(next);
  const changedTopLevelKeys = [...new Set([...previousTopLevel, ...nextTopLevel])]
    .filter((key) => stableJson(previous?.[key]) !== stableJson(next[key]))
    .sort();
  return {
    addedSites,
    removedSites,
    changedSites,
    spiderChanged: previous?.spider !== next.spider,
    spiderContentChanged: !sameSpiderHashes(previousSpiderHashes, nextSpiderHashes),
    changedTopLevelKeys,
  };
}

function siteMap(config: TvBoxConfig | undefined): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const [index, site] of (Array.isArray(config?.sites) ? config.sites : []).entries()) {
    const key = typeof site.key === "string" && site.key.length > 0
      ? site.key
      : typeof site.api === "string" && site.api.length > 0
        ? site.api
        : `#${index}`;
    result.set(key, site);
  }
  return result;
}

function cloneVersion(version: ConfigVersion): ConfigVersion {
  return {
    ...version,
    config: JSON.parse(JSON.stringify(version.config)) as TvBoxConfig,
    validators: { ...version.validators },
    change: {
      addedSites: [...version.change.addedSites],
      removedSites: [...version.change.removedSites],
      changedSites: [...version.change.changedSites],
      spiderChanged: version.change.spiderChanged,
      spiderContentChanged: version.change.spiderContentChanged ?? false,
      changedTopLevelKeys: [...version.change.changedTopLevelKeys],
    },
    spiderHashes: cloneSpiderHashes(version.spiderHashes),
  };
}

function cloneSpiderHashes(value: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return value ? Object.fromEntries(Object.entries(value)) : {};
}

function sameSpiderHashes(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
