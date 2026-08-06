import type { SourceCapabilities } from "../source/media-source.js";
import type { SpiderResponse } from "../spider/rpc.js";

export interface DesktopSpiderClientPort {
  readonly isRunning: boolean;
  readonly pid: number | null;
  readonly capabilities?: SourceCapabilities;
  init(ext: string, timeoutMs?: number): Promise<SpiderResponse>;
  homeContent(filter?: boolean, timeoutMs?: number): Promise<SpiderResponse>;
  categoryContent(
    typeId: string,
    page: number,
    filter?: boolean,
    extend?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<SpiderResponse>;
  searchContent(
    key: string,
    quick?: boolean,
    page?: number,
    timeoutMs?: number,
  ): Promise<SpiderResponse>;
  detailContent(ids: string[], timeoutMs?: number): Promise<SpiderResponse>;
  playerContent(
    flag: string,
    id: string,
    vipFlags?: string[],
    timeoutMs?: number,
  ): Promise<SpiderResponse>;
  stopPlayback?(): Promise<void>;
  destroy(): Promise<void>;
}
