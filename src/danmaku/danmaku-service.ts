import { SettingsRepository } from "../data/repositories.js";
import {
  buildDanmakuRenderItems,
  compileDanmakuRegex,
  DanmakuError,
  DanmakuTimeline,
  mergeDanmakuSettings,
  normalizeDanmakuSettings,
  publicDanmakuItem,
  safeDanmakuSource,
  type DanmakuItem,
  type DanmakuLoadInput,
  type DanmakuRenderItem,
  type DanmakuSettings,
  type DanmakuSettingsPatch,
  type DanmakuTimelineKind,
  type DanmakuUiState,
} from "./danmaku-types.js";
import { LocalDanmakuSourceAdapter, type DanmakuSourceAdapter } from "./danmaku-adapter.js";

export const DANMAKU_SETTINGS_KEY = "player.danmaku.settings";
const DANMAKU_UI_ITEM_LIMIT = 5_000;

export interface DanmakuServiceOptions {
  settings: SettingsRepository;
  adapter?: DanmakuSourceAdapter;
}

export class DanmakuService {
  private readonly settingsRepository: SettingsRepository;
  private readonly adapter: DanmakuSourceAdapter;
  private readonly timeline = new DanmakuTimeline();
  private settingsValue: DanmakuSettings;
  private items: DanmakuItem[] = [];
  private status: DanmakuUiState["status"] = "idle";
  private source: string | null = null;
  private timelineKind: DanmakuTimelineKind = "vod";
  private error: DanmakuUiState["error"] = null;
  private destroyed = false;

  public constructor(options: DanmakuServiceOptions) {
    this.settingsRepository = options.settings;
    this.adapter = options.adapter ?? new LocalDanmakuSourceAdapter();
    const persisted = normalizeDanmakuSettings(
      this.settingsRepository.get<unknown>(DANMAKU_SETTINGS_KEY),
    );
    try {
      this.validateSettings(persisted);
      this.settingsValue = persisted;
    } catch {
      this.settingsValue = normalizeDanmakuSettings(undefined);
    }
  }

  public async load(input: DanmakuLoadInput): Promise<DanmakuUiState> {
    this.assertAvailable();
    this.status = "loading";
    this.error = null;
    try {
      const items = await this.adapter.load(input);
      this.items = items.map((item) => ({ ...item }));
      this.source = safeDanmakuSource(input.source ?? this.items[0]?.source ?? "user-provided");
      this.timelineKind = input.timeline ?? "vod";
      this.timeline.reset();
      this.status = "ready";
      return this.uiState();
    } catch (error) {
      const mapped = danmakuError(error);
      this.status = "error";
      this.error = { code: mapped.code, message: mapped.message };
      throw mapped;
    }
  }

  public query(currentTimeMs = this.timeline.snapshot().currentTimeMs): DanmakuRenderItem[] {
    this.assertAvailable();
    return buildDanmakuRenderItems(this.adapter.query(), currentTimeMs, this.settingsValue);
  }

  public sync(currentTimeMs: number, eventType?: string, status?: string): DanmakuUiState {
    this.assertAvailable();
    const update = this.timeline.sync(currentTimeMs, eventType);
    if (status === "playing") this.timeline.setPlaying(true);
    if (status === "paused" || status === "stopped" || status === "ended" || status === "error") {
      this.timeline.setPlaying(false);
    }
    if (this.status === "idle" && this.items.length > 0) this.status = "ready";
    return this.stateWithTimeline(update.currentTimeMs);
  }

  public setPlaybackRate(rate: number): DanmakuUiState {
    this.assertAvailable();
    this.timeline.setPlaybackRate(rate);
    return this.stateWithTimeline(this.timeline.snapshot().currentTimeMs);
  }

  public setSettings(patch: DanmakuSettingsPatch): DanmakuUiState {
    this.assertAvailable();
    const next = mergeDanmakuSettings(this.settingsValue, patch);
    this.validateSettings(next);
    this.settingsRepository.set(DANMAKU_SETTINGS_KEY, next);
    this.settingsValue = next;
    return this.uiState();
  }

  public clear(): DanmakuUiState {
    this.assertAvailable();
    this.adapter.clear();
    this.items = [];
    this.source = null;
    this.status = "idle";
    this.error = null;
    this.timeline.reset();
    return this.uiState();
  }

  public uiState(): DanmakuUiState {
    this.assertAvailable();
    const snapshot = this.timeline.snapshot();
    return {
      status: this.status,
      settings: cloneSettings(this.settingsValue),
      source: this.source,
      timeline: this.timelineKind,
      playing: snapshot.playing,
      totalCount: this.items.length,
      sources: [...new Set(this.items.map((item) => safeDanmakuSource(item.source)))].slice(0, 32),
      items: this.items.slice(0, DANMAKU_UI_ITEM_LIMIT).map(publicDanmakuItem),
      currentTimeMs: snapshot.currentTimeMs,
      generation: snapshot.generation,
      error: this.error ? { ...this.error } : null,
    };
  }

  public close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.adapter.destroy();
    this.items = [];
    this.source = null;
    this.error = null;
  }

  public destroy(): void {
    this.close();
  }

  private stateWithTimeline(currentTimeMs: number): DanmakuUiState {
    const state = this.uiState();
    return { ...state, currentTimeMs };
  }

  private validateSettings(settings: DanmakuSettings): void {
    compileDanmakuRegex(settings.regex);
  }

  private assertAvailable(): void {
    if (this.destroyed) throw new DanmakuError("DANMAKU_DESTROYED", "弹幕服务已关闭");
  }
}

function cloneSettings(settings: DanmakuSettings): DanmakuSettings {
  return {
    ...settings,
    types: [...settings.types],
    sources: [...settings.sources],
  };
}

function danmakuError(error: unknown): DanmakuError {
  if (error instanceof DanmakuError) return error;
  return new DanmakuError(
    "DANMAKU_INVALID_PAYLOAD",
    error instanceof Error ? error.message : "弹幕内容无效",
    { cause: error },
  );
}
