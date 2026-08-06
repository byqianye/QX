import { describe, expect, it, vi } from "vitest";

import { ConfigHistoryStore } from "../src/config/history.js";
import { ConfigRefreshManager } from "../src/config/refresh.js";

const safe = JSON.stringify({ lives: [{ id: "live-1" }] });
const changed = JSON.stringify({
  spider: "https://code.example.invalid/new.mjs",
  sites: [{ key: "a", api: "js:https://code.example.invalid/new.mjs" }],
});

describe("configuration refresh review", () => {
  it("keeps dangerous changes pending until approval and never destroys current sessions", async () => {
    const history = new ConfigHistoryStore();
    const apply = vi.fn();
    const manager = new ConfigRefreshManager(history, { onApply: apply });
    const source = "https://config.example.invalid/config.json";
    history.recordSuccessful(source, "url", JSON.stringify({}));
    await manager.refresh(source, "url", async () => safe);
    expect(apply).toHaveBeenCalledTimes(1);
    const before = history.cached(source);

    const pending = await manager.refresh(source, "url", async () => changed);
    expect(pending.requiresApproval).toBe(true);
    expect(pending.applied).toBe(false);
    expect(manager.pending(source)?.id).toBe(pending.pendingVersionId);
    expect(history.cached(source)?.id).toBe(before?.id);
    expect(apply).toHaveBeenCalledTimes(1);

    await manager.approve(source, pending.pendingVersionId ?? undefined);
    expect(history.cached(source)?.config.spider).toBe("https://code.example.invalid/new.mjs");
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("can reject a pending refresh and uses a conservative default interval", async () => {
    const history = new ConfigHistoryStore();
    const manager = new ConfigRefreshManager(history, { intervalMs: 1 });
    expect(manager.interval).toBe(60_000);
    const source = "inline:config";
    const outcome = await manager.refresh(source, "json", async () => changed);
    expect(outcome.requiresApproval).toBe(true);
    manager.reject(source);
    expect(manager.pending(source)).toBeNull();
    expect(history.cached(source)).toBeNull();

    manager.start(source, "json", async () => safe);
    expect(manager.isRunning).toBe(true);
    manager.stop();
    expect(manager.isRunning).toBe(false);
  });

  it("reviews Spider content changes even when the config response is not modified", async () => {
    const history = new ConfigHistoryStore();
    const apply = vi.fn();
    const source = "https://config.example.invalid/config.json";
    const spider = "https://code.example.invalid/demo.mjs";
    const body = JSON.stringify({ sites: [{ key: "js", api: `js:${spider}` }] });
    let spiderHash = "hash-v1";
    const manager = new ConfigRefreshManager(history, {
      spiderHashes: async () => ({ [spider]: spiderHash }),
      onApply: apply,
    });

    await manager.refresh(source, "url", async () => ({ body }), true);
    expect(apply).toHaveBeenCalledTimes(1);

    spiderHash = "hash-v2";
    const pending = await manager.refresh(source, "url", async () => ({ notModified: true }));
    expect(pending.requiresApproval).toBe(true);
    expect(pending.result.version?.change.spiderContentChanged).toBe(true);
    expect(pending.applied).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
