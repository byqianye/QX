import { type DataLayerError } from "./errors.js";
import { PlaybackProgressRepository, type PlaybackProgressRecord } from "./repositories.js";

export type ProgressFlushReason = "debounce" | "interval" | "pause" | "stop" | "episode-change" | "app-close";

export interface ProgressWriterScheduler {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PlaybackProgressWriterOptions {
  debounceMs?: number;
  intervalMs?: number;
  scheduler?: ProgressWriterScheduler;
}

/**
 * Coalesces renderer timeupdate-like events before touching SQLite. G51 owns
 * the playback wiring; this class fixes the persistence contract and flush
 * points that wiring must use.
 */
export class PlaybackProgressWriter {
  private readonly debounceMs: number;
  private readonly intervalMs: number;
  private readonly scheduler: ProgressWriterScheduler;
  private pending: PlaybackProgressRecord | null = null;
  private debounceHandle: unknown;
  private intervalHandle: unknown;
  private lastFlushReasonValue: ProgressFlushReason | null = null;

  public constructor(
    private readonly repository: PlaybackProgressRepository,
    options: PlaybackProgressWriterOptions = {},
  ) {
    this.debounceMs = Math.max(1, Math.floor(options.debounceMs ?? 750));
    this.intervalMs = Math.max(this.debounceMs, Math.floor(options.intervalMs ?? 5_000));
    this.scheduler = options.scheduler ?? {
      setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  public update(record: PlaybackProgressRecord): void {
    this.pending = { ...record };
    if (this.debounceHandle === undefined) {
      this.debounceHandle = this.scheduler.setTimeout(() => {
        this.debounceHandle = undefined;
        this.flush("debounce");
      }, this.debounceMs);
    }
    if (this.intervalHandle === undefined) {
      this.intervalHandle = this.scheduler.setTimeout(() => {
        this.intervalHandle = undefined;
        this.flush("interval");
      }, this.intervalMs);
    }
  }

  public pause(): void {
    this.flush("pause");
  }

  public stop(): void {
    this.flush("stop");
  }

  public episodeChange(): void {
    this.flush("episode-change");
  }

  public appClose(): void {
    this.flush("app-close");
  }

  public flush(reason: ProgressFlushReason): void {
    const pending = this.pending;
    if (!pending) return;
    this.repository.upsert(pending);
    this.pending = null;
    this.lastFlushReasonValue = reason;
    this.clearTimers();
  }

  public get hasPendingWrite(): boolean {
    return this.pending !== null;
  }

  public get lastFlushReason(): ProgressFlushReason | null {
    return this.lastFlushReasonValue;
  }

  private clearTimers(): void {
    if (this.debounceHandle !== undefined) this.scheduler.clearTimeout(this.debounceHandle);
    if (this.intervalHandle !== undefined) this.scheduler.clearTimeout(this.intervalHandle);
    this.debounceHandle = undefined;
    this.intervalHandle = undefined;
  }
}

export type PlaybackProgressWriterError = DataLayerError;
