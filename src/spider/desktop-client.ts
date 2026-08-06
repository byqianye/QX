import { routeSpiderApi, type SpiderResponse } from "./rpc.js";
import { JvmSidecar, type JvmSidecarOptions } from "./jvm-sidecar.js";

export interface DesktopSpiderClientOptions extends JvmSidecarOptions {
  api: string;
}

/**
 * Desktop-facing Spider seam for the JVM-native engine.
 *
 * The desktop caller owns only this session. Sidecar startup, RPC dispatch,
 * timeout termination, and process destruction remain behind the seam.
 */
export class DesktopSpiderClient {
  private readonly api: string;
  private readonly sidecar: JvmSidecar;
  private initialized = false;

  public constructor(options: DesktopSpiderClientOptions) {
    const engine = routeSpiderApi(options.api);
    if (engine !== "java") {
      throw new Error(
        `Desktop Spider client only supports JVM-native csp_* APIs in this spike: ${options.api}`,
      );
    }

    const { api, ...sidecarOptions } = options;
    this.api = api;
    this.sidecar = new JvmSidecar(sidecarOptions);
  }

  public get isRunning(): boolean {
    return this.sidecar.isRunning;
  }

  public get pid(): number | null {
    return this.sidecar.pid;
  }

  public async init(ext: string, timeoutMs?: number): Promise<SpiderResponse> {
    await this.sidecar.start();
    try {
      const response = timeoutMs === undefined
        ? await this.sidecar.init(ext)
        : await this.sidecar.init(ext, timeoutMs);
      this.initialized = response.ok;
      return response;
    } catch (error) {
      this.initialized = false;
      throw error;
    }
  }

  public homeContent(filter = false, timeoutMs?: number): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined
      ? this.sidecar.homeContent(filter)
      : this.sidecar.homeContent(filter, timeoutMs);
  }

  public categoryContent(
    typeId: string,
    page: number,
    filter = false,
    extend: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined
      ? this.sidecar.categoryContent(typeId, page, filter, extend)
      : this.sidecar.categoryContent(typeId, page, filter, extend, timeoutMs);
  }

  public searchContent(
    key: string,
    quick = false,
    page = 1,
    timeoutMs?: number,
  ): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined
      ? this.sidecar.searchContent(key, quick, page)
      : this.sidecar.searchContent(key, quick, page, timeoutMs);
  }

  public detailContent(ids: string[], timeoutMs?: number): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined
      ? this.sidecar.detailContent(ids)
      : this.sidecar.detailContent(ids, timeoutMs);
  }

  public playerContent(
    flag: string,
    id: string,
    vipFlags: string[] = [],
    timeoutMs?: number,
  ): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined
      ? this.sidecar.playerContent(flag, id, vipFlags)
      : this.sidecar.playerContent(flag, id, vipFlags, timeoutMs);
  }

  public async destroy(): Promise<void> {
    this.initialized = false;
    await this.sidecar.destroy();
  }

  private assertInitialized(): void {
    if (!this.initialized || !this.sidecar.isRunning) {
      throw new Error(`Desktop Spider is not initialized: ${this.api}`);
    }
  }
}
