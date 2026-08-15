import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type ThemeMode = "system" | "light" | "dark";
export type PersistedNavigation = "home" | "category" | "search" | "detail" | "history" | "favorites" | "follow" | "settings" | "live" | "local" | "downloads";

export interface PersistedCategory {
  typeId: string;
  page: number;
}

export interface PersistedSearch {
  key: string;
  page: number;
}

export interface PersistedPageState {
  navigation: PersistedNavigation;
  siteKey: string | null;
  category: PersistedCategory | null;
  search: PersistedSearch | null;
  scrollTop: number;
  recentDetailId: string | null;
}

export interface PersistedWindowState {
  width: number;
  height: number;
  x: number | null;
  y: number | null;
  isMaximized: boolean;
}

export interface DesktopPersistedState {
  version: 1;
  theme: ThemeMode;
  window: PersistedWindowState;
  page: PersistedPageState;
}

export interface PageStatePatch {
  navigation?: PersistedNavigation;
  siteKey?: string | null;
  category?: PersistedCategory | null;
  search?: PersistedSearch | null;
  scrollTop?: number;
  recentDetailId?: string | null;
}

export interface DesktopStatePatch {
  theme?: ThemeMode;
  page?: PageStatePatch;
  window?: Partial<PersistedWindowState>;
}

export type StatePersistenceDiagnosticCode =
  | "STATE_PERSISTENCE_CORRUPT"
  | "STATE_PERSISTENCE_WRITE_FAILED"
  | "DATABASE_OPEN_FAILED"
  | "DATABASE_MIGRATION_FAILED"
  | "DATABASE_CORRUPT"
  | "DATABASE_VERSION_TOO_NEW"
  | "DATABASE_WRITE_FAILED"
  | "LEGACY_MIGRATION_FAILED";

export interface StatePersistenceDiagnostic {
  code: StatePersistenceDiagnosticCode;
  message: string;
}

export interface StatePersistenceResult {
  ok: boolean;
  state: DesktopPersistedState;
  diagnostic: StatePersistenceDiagnostic | null;
}

export interface DesktopStateFileSystem {
  mkdirSync(path: string, options: { recursive: true }): unknown;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string, encoding: "utf8"): void;
  renameSync(source: string, destination: string): void;
  unlinkSync(path: string): void;
}

export interface DesktopStateStorePort {
  readonly state: DesktopPersistedState;
  readonly lastDiagnostic: StatePersistenceDiagnostic | null;
  patch(update: DesktopStatePatch): StatePersistenceResult;
  rendererState(): RendererPersistenceState;
}

export interface RendererPersistenceState {
  theme: ThemeMode;
  navigation: PersistedNavigation;
  siteKey: string | null;
  category: PersistedCategory | null;
  search: PersistedSearch | null;
  scrollTop: number;
  recentDetailId: string | null;
  diagnostic: StatePersistenceDiagnostic | null;
}

export interface DisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RestoredWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_WINDOW_WIDTH = 960;
export const MIN_WINDOW_HEIGHT = 640;

export const DEFAULT_DESKTOP_STATE: DesktopPersistedState = {
  version: 1,
  theme: "light",
  window: {
    width: 1280,
    height: 860,
    x: null,
    y: null,
    isMaximized: false,
  },
  page: {
    navigation: "home",
    siteKey: null,
    category: null,
    search: null,
    scrollTop: 0,
    recentDetailId: null,
  },
};

const defaultFileSystem: DesktopStateFileSystem = {
  mkdirSync: (path, options) => mkdirSync(path, options),
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  writeFileSync: (path, data, encoding) => writeFileSync(path, data, encoding),
  renameSync: (source, destination) => renameSync(source, destination),
  unlinkSync: (path) => unlinkSync(path),
};

export class JsonFileDesktopStateStore implements DesktopStateStorePort {
  private stateValue: DesktopPersistedState;
  private diagnostic: StatePersistenceDiagnostic | null = null;

  public constructor(
    private readonly path: string,
    private readonly fileSystem: DesktopStateFileSystem = defaultFileSystem,
  ) {
    this.stateValue = this.readState();
  }

  public get state(): DesktopPersistedState {
    return cloneState(this.stateValue);
  }

  public get lastDiagnostic(): StatePersistenceDiagnostic | null {
    return this.diagnostic ? { ...this.diagnostic } : null;
  }

  public patch(update: DesktopStatePatch): StatePersistenceResult {
    const current = this.stateValue;
    this.stateValue = normalizeState({
      ...current,
      ...(update.theme === undefined ? {} : { theme: update.theme }),
      page: update.page ? normalizePageState({ ...current.page, ...update.page }) : current.page,
      window: update.window ? normalizeWindowState({ ...current.window, ...update.window }) : current.window,
    });
    const ok = this.writeState();
    return {
      ok,
      state: this.state,
      diagnostic: this.lastDiagnostic,
    };
  }

  public rendererState(): RendererPersistenceState {
    const state = this.stateValue;
    return {
      theme: state.theme,
      navigation: state.page.navigation,
      siteKey: state.page.siteKey,
      category: state.page.category ? { ...state.page.category } : null,
      search: state.page.search ? { ...state.page.search } : null,
      scrollTop: state.page.scrollTop,
      recentDetailId: state.page.recentDetailId,
      diagnostic: this.lastDiagnostic,
    };
  }

  private readState(): DesktopPersistedState {
    let raw: string;
    try {
      raw = this.fileSystem.readFileSync(this.path, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return cloneState(DEFAULT_DESKTOP_STATE);
      return this.handleCorruptState();
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      const state = parseState(parsed);
      if (!state) return this.handleCorruptState();
      return state;
    } catch {
      return this.handleCorruptState();
    }
  }

  private handleCorruptState(): DesktopPersistedState {
    this.diagnostic = {
      code: "STATE_PERSISTENCE_CORRUPT",
      message: "桌面状态文件损坏，已回退到安全默认值。",
    };
    try {
      this.fileSystem.renameSync(this.path, `${this.path}.corrupt-${Date.now()}.bak`);
    } catch {
      // The safe default is still valid when the damaged file cannot be moved.
    }
    return cloneState(DEFAULT_DESKTOP_STATE);
  }

  private writeState(): boolean {
    const temporaryPath = `${this.path}.tmp`;
    try {
      this.fileSystem.mkdirSync(dirname(this.path), { recursive: true });
      this.fileSystem.writeFileSync(temporaryPath, `${JSON.stringify(this.stateValue, null, 2)}\n`, "utf8");
      this.fileSystem.renameSync(temporaryPath, this.path);
      this.diagnostic = null;
      return true;
    } catch {
      try {
        this.fileSystem.unlinkSync(temporaryPath);
      } catch {
        // A failed cleanup must not turn a recoverable write failure into a startup failure.
      }
      this.diagnostic = {
        code: "STATE_PERSISTENCE_WRITE_FAILED",
        message: "桌面状态未能保存，当前会话仍可继续使用。",
      };
      return false;
    }
  }
}

export function restoreWindowBounds(
  state: PersistedWindowState,
  displays: readonly DisplayWorkArea[],
  primaryDisplay: DisplayWorkArea | undefined = displays[0],
): RestoredWindowBounds {
  const primary = primaryDisplay ?? { x: 0, y: 0, width: 1920, height: 1040 };
  const width = clampDimension(state.width, MIN_WINDOW_WIDTH, primary.width, primary.width);
  const height = clampDimension(state.height, MIN_WINDOW_HEIGHT, primary.height, primary.height);
  const candidate = {
    x: finiteOrNull(state.x),
    y: finiteOrNull(state.y),
  };
  const matchingDisplay = displays.find((display) => hasVisibleIntersection(
    { x: candidate.x ?? centerCoordinate(display.x, display.width, width), y: candidate.y ?? centerCoordinate(display.y, display.height, height), width, height },
    display,
  ));
  const target = matchingDisplay ?? primary;
  const x = candidate.x === null || !matchingDisplay
    ? centerCoordinate(target.x, target.width, width)
    : clampCoordinate(candidate.x, target.x, target.width, width);
  const y = candidate.y === null || !matchingDisplay
    ? centerCoordinate(target.y, target.height, height)
    : clampCoordinate(candidate.y, target.y, target.height, height);
  return { x, y, width, height };
}

function parseState(value: unknown): DesktopPersistedState | null {
  return parseDesktopState(value);
}

export function parseDesktopState(value: unknown): DesktopPersistedState | null {
  if (!isRecord(value) || value.version !== 1) return null;
  return normalizeState(value);
}

export function normalizeDesktopState(value: unknown): DesktopPersistedState {
  return parseDesktopState(value) ?? cloneState(DEFAULT_DESKTOP_STATE);
}

function normalizeState(value: Record<string, unknown>): DesktopPersistedState {
  const page = isRecord(value.page) ? value.page : {};
  const window = isRecord(value.window) ? value.window : {};
  return {
    version: 1,
    theme: isThemeMode(value.theme) ? value.theme : "light",
    window: normalizeWindowState(window),
    page: normalizePageState(page),
  };
}

function normalizeWindowState(value: Record<string, unknown>): PersistedWindowState {
  return {
    width: finitePositive(value.width) ?? DEFAULT_DESKTOP_STATE.window.width,
    height: finitePositive(value.height) ?? DEFAULT_DESKTOP_STATE.window.height,
    x: finiteOrNull(value.x),
    y: finiteOrNull(value.y),
    isMaximized: value.isMaximized === true,
  };
}

function normalizePageState(value: Record<string, unknown>): PersistedPageState {
  return {
    navigation: isNavigation(value.navigation) ? value.navigation : "home",
    siteKey: safeIdentifier(value.siteKey),
    category: normalizeCategory(value.category),
    search: normalizeSearch(value.search),
    scrollTop: clampNumber(value.scrollTop, 0, 10_000_000, 0),
    recentDetailId: safeIdentifier(value.recentDetailId),
  };
}

function normalizeCategory(value: unknown): PersistedCategory | null {
  if (!isRecord(value)) return null;
  const typeId = safeText(value.typeId, 128);
  const page = clampNumber(value.page, 1, 10_000, 1);
  return typeId ? { typeId, page } : null;
}

function normalizeSearch(value: unknown): PersistedSearch | null {
  if (!isRecord(value)) return null;
  const key = safeText(value.key, 200);
  const page = clampNumber(value.page, 1, 10_000, 1);
  return key ? { key, page } : null;
}

function safeIdentifier(value: unknown): string | null {
  const text = safeText(value, 256);
  if (!text || /^https?:\/\//i.test(text) || sensitivePattern.test(text)) return null;
  return text;
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (text.length === 0 || /^https?:\/\//i.test(text) || sensitivePattern.test(text)) return null;
  return text.slice(0, maxLength);
}

function cloneState(state: DesktopPersistedState): DesktopPersistedState {
  return {
    version: 1,
    theme: state.theme,
    window: { ...state.window },
    page: {
      ...state.page,
      category: state.page.category ? { ...state.page.category } : null,
      search: state.page.search ? { ...state.page.search } : null,
    },
  };
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function isNavigation(value: unknown): value is PersistedNavigation {
  return value === "home" || value === "category" || value === "search" || value === "detail"
    || value === "history" || value === "favorites" || value === "follow" || value === "settings" || value === "live" || value === "local" || value === "downloads";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function clampDimension(value: number, minimum: number, maximum: number, fallback: number): number {
  return Math.min(maximum, Math.max(minimum, finitePositive(value) ?? fallback));
}

function centerCoordinate(origin: number, size: number, windowSize: number): number {
  return Math.round(origin + (size - windowSize) / 2);
}

function clampCoordinate(value: number, origin: number, size: number, windowSize: number): number {
  if (windowSize >= size) return origin;
  return Math.min(origin + size - 64, Math.max(origin - windowSize + 64, Math.round(value)));
}

function hasVisibleIntersection(
  window: RestoredWindowBounds,
  display: DisplayWorkArea,
): boolean {
  const right = Math.min(window.x + window.width, display.x + display.width);
  const bottom = Math.min(window.y + window.height, display.y + display.height);
  const left = Math.max(window.x, display.x);
  const top = Math.max(window.y, display.y);
  return right - left >= 64 && bottom - top >= 64;
}

const sensitivePattern = /(?:authorization|cookie|token|api[\s_-]*key|password|secret)\s*[:=]/i;
