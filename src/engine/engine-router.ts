import type { TvBoxConfig, TvBoxSite } from "../config/decoder.js";
import type { DesktopSpiderClientContext } from "../desktop/spider-session.js";
import {
  resolveDesktopSourceBinding,
  type DesktopSourceBinding,
} from "../desktop/source-router.js";
import type { DesktopSpiderClientPort } from "../desktop/spider-client-port.js";
import { DesktopSpiderClient } from "../spider/desktop-client.js";
import { PythonDesktopClient } from "../spider/python-client.js";
import { QuickJsDesktopClient } from "../spider/quickjs-client.js";
import { JellyfinDesktopClient } from "../jellyfin/jellyfin-client.js";
import type { JellyfinConfig } from "../jellyfin/jellyfin-adapter.js";
import type { SourceEngine } from "../source/media-source.js";
import type { SourceCapabilities } from "../source/media-source.js";
import type { SpiderResponse } from "../spider/rpc.js";
import {
  SourceSessionRegistry,
  type SourceSessionLease,
  type SourceSessionEntry,
} from "./source-session-registry.js";

export interface EngineRouterRuntime {
  javaExecutable: string;
  hostJar: string;
  spiderJar: string;
  spiderClass: string;
  pythonExecutable?: string;
  pythonEnvironment?: NodeJS.ProcessEnv;
  jellyfinConfig?: JellyfinConfig;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
}

export interface EngineRouterOptions {
  maxActiveSessions?: number;
  idleSessionMs?: number;
}

export class EngineRouter {
  public readonly sessions: SourceSessionRegistry<DesktopSpiderClientPort>;

  public constructor(options: EngineRouterOptions = {}) {
    this.sessions = new SourceSessionRegistry<DesktopSpiderClientPort>({
      ...(options.maxActiveSessions === undefined ? {} : { maxActiveSessions: options.maxActiveSessions }),
      ...(options.idleSessionMs === undefined ? {} : { idleMs: options.idleSessionMs }),
    });
  }

  public resolve(config: TvBoxConfig, site: TvBoxSite): DesktopSourceBinding {
    const binding = resolveDesktopSourceBinding(config, site);
    if (!binding) {
      const error = new Error(`No supported engine binding for site: ${String(site.api)}`) as Error & { code: string };
      error.code = "ENGINE_UNSUPPORTED";
      throw error;
    }
    return binding;
  }

  public createClient(
    binding: DesktopSourceBinding,
    context: DesktopSpiderClientContext,
    runtime: EngineRouterRuntime,
  ): DesktopSpiderClientPort {
    const common = {
      api: binding.api,
      ...(runtime.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: runtime.requestTimeoutMs }),
    };
    if (binding.engine === "quickjs") {
      if (!binding.script) throw new Error(`QuickJS script is missing for ${binding.api}`);
      return new QuickJsDesktopClient({
        ...common,
        script: binding.script,
        ...(runtime.requestTimeoutMs === undefined ? {} : { maxExecutionMs: runtime.requestTimeoutMs }),
      });
    }
    if (binding.engine === "python") {
      if (!binding.script) throw new Error(`Python Spider script is missing for ${binding.api}`);
      return new PythonDesktopClient({
        api: binding.api,
        pythonExecutable: runtime.pythonExecutable ?? "python",
        ...(runtime.pythonEnvironment ? { env: runtime.pythonEnvironment } : {}),
        script: binding.script,
        ...(runtime.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: runtime.requestTimeoutMs }),
        ...(runtime.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: runtime.startupTimeoutMs }),
      });
    }
    if (binding.engine === "jvm") {
      const spiderClass = binding.definition?.className ?? runtime.spiderClass;
      return new DesktopSpiderClient({
        api: binding.api,
        javaExecutable: runtime.javaExecutable,
        hostJar: runtime.hostJar,
        spiderJar: runtime.spiderJar,
        spiderClass,
        binding: {
          configSource: context.sourceId,
          siteKey: context.siteKey,
          sessionId: context.sessionId,
          api: binding.api,
          spiderJar: runtime.spiderJar,
          spiderClass,
        },
        ...(runtime.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: runtime.requestTimeoutMs }),
        ...(runtime.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: runtime.startupTimeoutMs }),
      });
    }
    if (binding.engine === "jellyfin") {
      const config = binding.jellyfinConfig ?? runtime.jellyfinConfig;
      if (!config) {
        const error = new Error("Jellyfin configuration is unavailable") as Error & { code: string };
        error.code = "JELLYFIN_CONFIG_UNAVAILABLE";
        throw error;
      }
      return new JellyfinDesktopClient({
        config,
        ...(runtime.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: runtime.requestTimeoutMs }),
      });
    }
    throw new Error(`Engine ${binding.engine} does not expose a desktop Spider client yet`);
  }

  public async acquireClient(
    binding: DesktopSourceBinding,
    context: DesktopSpiderClientContext,
    runtime: EngineRouterRuntime,
  ): Promise<DesktopSpiderClientPort> {
    const key = this.key(
      context.sourceId,
      context.siteKey,
      binding,
      binding.engine === "jellyfin" ? context.sessionId : undefined,
    );
    const lease = await this.sessions.acquire(
      key,
      () => this.createClient(binding, context, runtime),
      (client) => client.destroy(),
    );
    return new RegistryLeasedClient(lease, binding.capabilities);
  }

  public key(sourceId: string, siteKey: string, binding: DesktopSourceBinding, sessionId?: string): string {
    const sessionScope = binding.engine === "jellyfin" && sessionId
      ? `\u0000${sessionId}`
      : "";
    return `${sourceId}\u0000${siteKey}\u0000${binding.engine}\u0000${binding.api}${sessionScope}`;
  }

  public state(): {
    active: number;
    maxActive: number;
    sessions: readonly SourceSessionEntry<DesktopSpiderClientPort>[];
    closed: boolean;
  } {
    return this.sessions.state();
  }

  public async destroyAll(): Promise<void> {
    await this.sessions.destroyAll();
  }
}

/**
 * A desktop session owns a lease, not the shared engine client. Releasing one
 * browser session therefore cannot tear down a source still used elsewhere.
 */
class RegistryLeasedClient implements DesktopSpiderClientPort {
  private readonly lease: SourceSessionLease<DesktopSpiderClientPort>;
  private readonly fallbackCapabilities: SourceCapabilities;
  private initPromise: Promise<SpiderResponse> | null = null;
  private initResponse: SpiderResponse | null = null;
  private destroyPromise: Promise<void> | null = null;
  private released = false;

  public constructor(
    lease: SourceSessionLease<DesktopSpiderClientPort>,
    fallbackCapabilities: SourceCapabilities,
  ) {
    this.lease = lease;
    this.fallbackCapabilities = fallbackCapabilities;
  }

  public get isRunning(): boolean {
    return this.lease.client.isRunning;
  }

  public get pid(): number | null {
    return this.lease.client.pid;
  }

  public get capabilities(): SourceCapabilities {
    return this.lease.client.capabilities ?? this.fallbackCapabilities;
  }

  public init(ext: string, timeoutMs?: number): Promise<SpiderResponse> {
    if (this.released) return Promise.reject(new Error("Source session lease is released"));
    if (this.initResponse && this.lease.client.isRunning) return Promise.resolve(this.initResponse);
    if (this.initPromise) return this.initPromise;
    const promise = (async () => {
      const response = await this.lease.init((client) => client.init(ext, timeoutMs));
      if (response.ok) this.initResponse = response;
      return response;
    })();
    this.initPromise = promise.finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  public homeContent(filter = false, timeoutMs?: number): Promise<SpiderResponse> {
    return this.lease.client.homeContent(filter, timeoutMs);
  }

  public categoryContent(
    typeId: string,
    page: number,
    filter = false,
    extend: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<SpiderResponse> {
    return this.lease.client.categoryContent(typeId, page, filter, extend, timeoutMs);
  }

  public searchContent(
    key: string,
    quick = false,
    page = 1,
    timeoutMs?: number,
  ): Promise<SpiderResponse> {
    return this.lease.client.searchContent(key, quick, page, timeoutMs);
  }

  public detailContent(ids: string[], timeoutMs?: number): Promise<SpiderResponse> {
    return this.lease.client.detailContent(ids, timeoutMs);
  }

  public playerContent(
    flag: string,
    id: string,
    vipFlags: string[] = [],
    timeoutMs?: number,
  ): Promise<SpiderResponse> {
    return this.lease.client.playerContent(flag, id, vipFlags, timeoutMs);
  }

  public stopPlayback(): Promise<void> {
    return this.lease.client.stopPlayback?.() ?? Promise.resolve();
  }

  public destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.released = true;
    this.destroyPromise = (async () => {
      if (this.initPromise) await this.initPromise.catch(() => undefined);
      await this.lease.release();
    })();
    return this.destroyPromise;
  }
}

export function engineCapabilitiesForRoute(engine: SourceEngine): "jvm" | "quickjs" | "python" | "jellyfin" | "fixture" {
  return engine;
}
