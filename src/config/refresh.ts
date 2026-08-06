import type { TvBoxConfig } from "./decoder.js";
import {
  ConfigHistoryStore,
  type ConfigHistorySourceKind,
  type ConfigRefreshLoader,
  type ConfigRefreshResult,
  type ConfigSpiderHashLoader,
  type ConfigVersion,
} from "./history.js";

export interface ConfigRefreshOutcome {
  source: string;
  result: ConfigRefreshResult;
  applied: boolean;
  requiresApproval: boolean;
  pendingVersionId: string | null;
}

export interface ConfigRefreshManagerOptions {
  intervalMs?: number;
  onApply?: (config: TvBoxConfig, version: ConfigVersion) => void | Promise<void>;
  spiderHashes?: ConfigSpiderHashLoader;
}

export class ConfigRefreshManager {
  private readonly intervalMs: number;
  private readonly onApply: ((config: TvBoxConfig, version: ConfigVersion) => void | Promise<void>) | undefined;
  private readonly spiderHashes: ConfigSpiderHashLoader | undefined;
  private readonly pendingVersions = new Map<string, ConfigVersion>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private scheduled: {
    source: string;
    sourceKind: ConfigHistorySourceKind;
    loader: ConfigRefreshLoader;
  } | undefined;

  public constructor(
    private readonly history: ConfigHistoryStore,
    options: ConfigRefreshManagerOptions = {},
  ) {
    this.intervalMs = Math.max(60_000, Math.floor(options.intervalMs ?? 6 * 60 * 60 * 1000));
    this.onApply = options.onApply;
    this.spiderHashes = options.spiderHashes;
  }

  public get interval(): number {
    return this.intervalMs;
  }

  public get isRunning(): boolean {
    return this.timer !== undefined;
  }

  public pending(source: string): ConfigVersion | null {
    const version = this.pendingVersions.get(source);
    return version ? cloneVersion(version) : null;
  }

  public async refresh(
    source: string,
    sourceKind: ConfigHistorySourceKind,
    loader: ConfigRefreshLoader,
    approveDangerous = false,
  ): Promise<ConfigRefreshOutcome> {
    const before = this.history.cached(source);
    const result = await this.history.refresh(source, sourceKind, loader, this.spiderHashes);
    if (!result.version || !result.changed) {
      return {
        source,
        result,
        applied: false,
        requiresApproval: false,
        pendingVersionId: this.pendingVersions.get(source)?.id ?? null,
      };
    }
    const dangerous = isDangerous(result.version);
    if (dangerous && !approveDangerous) {
      this.pendingVersions.set(source, result.version);
      this.history.setActive(source, before?.id ?? null);
      return {
        source,
        result: { ...result, config: before?.config ?? null, version: before, usedCache: before !== null },
        applied: false,
        requiresApproval: true,
        pendingVersionId: result.version.id,
      };
    }
    this.pendingVersions.delete(source);
    await this.onApply?.(result.version.config, result.version);
    return {
      source,
      result,
      applied: true,
      requiresApproval: false,
      pendingVersionId: null,
    };
  }

  public async approve(source: string, versionId?: string): Promise<ConfigVersion> {
    const pending = this.pendingVersions.get(source);
    if (!pending || (versionId !== undefined && pending.id !== versionId)) {
      throw new Error(`No pending config refresh for: ${source}`);
    }
    const version = this.history.rollback(source, pending.id);
    this.pendingVersions.delete(source);
    await this.onApply?.(version.config, version);
    return version;
  }

  public reject(source: string): void {
    const pending = this.pendingVersions.get(source);
    if (!pending) return;
    this.pendingVersions.delete(source);
    this.history.delete(source, pending.id);
  }

  public start(source: string, sourceKind: ConfigHistorySourceKind, loader: ConfigRefreshLoader): void {
    this.stop();
    this.scheduled = { source, sourceKind, loader };
    this.timer = setInterval(() => {
      const scheduled = this.scheduled;
      if (scheduled) void this.refresh(scheduled.source, scheduled.sourceKind, scheduled.loader);
    }, this.intervalMs);
    const timer = this.timer as ReturnType<typeof setInterval> & { unref?: () => void };
    timer.unref?.();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.scheduled = undefined;
  }
}

function isDangerous(version: ConfigVersion): boolean {
  return version.change.spiderChanged
    || version.change.spiderContentChanged
    || version.change.addedSites.length > 0
    || version.change.removedSites.length > 0
    || version.change.changedSites.length > 0;
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
    spiderHashes: { ...version.spiderHashes },
  };
}
