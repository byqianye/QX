import {
  DEFAULT_DESKTOP_STATE,
  normalizeDesktopState,
  type DesktopPersistedState,
  type DesktopStatePatch,
  type DesktopStateStorePort,
  type RendererPersistenceState,
  type StatePersistenceDiagnostic,
  type StatePersistenceResult,
} from "../desktop/state-persistence.js";
import { isDataLayerError, type DataLayerError } from "./errors.js";
import { SettingsRepository } from "./repositories.js";
import { type SqliteDataLayer } from "./sqlite.js";

const DESKTOP_STATE_KEY = "desktop-state";

export class SqliteDesktopStateStore implements DesktopStateStorePort {
  private readonly settings: SettingsRepository;
  private stateValue: DesktopPersistedState;
  private diagnostic: StatePersistenceDiagnostic | null;

  public constructor(
    private readonly db: SqliteDataLayer,
    initialDiagnostic: DataLayerError | null = null,
  ) {
    this.settings = new SettingsRepository(db);
    this.diagnostic = initialDiagnostic ? diagnosticFrom(initialDiagnostic) : null;
    try {
      const persisted = this.settings.get<unknown>(DESKTOP_STATE_KEY);
      this.stateValue = persisted === null
        ? cloneState(DEFAULT_DESKTOP_STATE)
        : normalizeDesktopState(persisted);
      if (persisted !== null && !isDesktopState(persisted)) {
        this.diagnostic ??= {
          code: "DATABASE_CORRUPT",
          message: "数据库中的桌面状态无法读取，已回退到安全默认值。",
        };
      }
    } catch (error) {
      this.stateValue = cloneState(DEFAULT_DESKTOP_STATE);
      this.diagnostic ??= isDataLayerError(error)
        ? diagnosticFrom(error)
        : {
            code: "DATABASE_CORRUPT",
            message: "数据库中的桌面状态无法读取，已回退到安全默认值。",
          };
    }
  }

  public get state(): DesktopPersistedState {
    return cloneState(this.stateValue);
  }

  public get lastDiagnostic(): StatePersistenceDiagnostic | null {
    return this.diagnostic ? { ...this.diagnostic } : null;
  }

  public patch(update: DesktopStatePatch): StatePersistenceResult {
    const current = this.stateValue;
    this.stateValue = normalizeDesktopState({
      ...current,
      ...(update.theme === undefined ? {} : { theme: update.theme }),
      page: update.page ? { ...current.page, ...update.page } : current.page,
      window: update.window ? { ...current.window, ...update.window } : current.window,
    });
    try {
      this.settings.set(DESKTOP_STATE_KEY, this.stateValue);
      this.diagnostic = null;
      return { ok: true, state: this.state, diagnostic: null };
    } catch (error) {
      this.diagnostic = isDataLayerError(error)
        ? diagnosticFrom(error)
        : {
            code: "DATABASE_WRITE_FAILED",
            message: "数据库写入失败，当前会话仍可继续使用。",
          };
      return { ok: false, state: this.state, diagnostic: this.lastDiagnostic };
    }
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
}

function diagnosticFrom(error: DataLayerError): StatePersistenceDiagnostic {
  return { code: error.code, message: error.message };
}

function isDesktopState(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { version?: unknown }).version === 1;
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
