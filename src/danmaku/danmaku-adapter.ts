import {
  DanmakuError,
  parseDanmakuPayload,
  type DanmakuItem,
  type DanmakuLoadInput,
} from "./danmaku-types.js";

export interface DanmakuSourceAdapter {
  load(input: DanmakuLoadInput): Promise<readonly DanmakuItem[]>;
  query(): readonly DanmakuItem[];
  cancel(): void;
  clear(): void;
  destroy(): void;
}

/**
 * Adapter for user-provided, local, self-hosted, or fixture content.
 * Network discovery and third-party platform APIs deliberately do not live here.
 */
export class LocalDanmakuSourceAdapter implements DanmakuSourceAdapter {
  private items: DanmakuItem[] = [];
  private operation = 0;
  private destroyed = false;

  public async load(input: DanmakuLoadInput): Promise<readonly DanmakuItem[]> {
    this.assertAvailable();
    const operation = ++this.operation;
    await Promise.resolve();
    if (operation !== this.operation) {
      throw new DanmakuError("DANMAKU_CANCELLED", "弹幕加载已取消");
    }
    const items = parseDanmakuPayload(input.data, input.format ?? "auto", input.source ?? "user-provided");
    this.items = items;
    return this.query();
  }

  public query(): readonly DanmakuItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  public cancel(): void {
    this.operation += 1;
  }

  public clear(): void {
    this.operation += 1;
    this.items = [];
  }

  public destroy(): void {
    this.operation += 1;
    this.destroyed = true;
    this.items = [];
  }

  private assertAvailable(): void {
    if (this.destroyed) throw new DanmakuError("DANMAKU_DESTROYED", "弹幕适配器已销毁");
  }
}
