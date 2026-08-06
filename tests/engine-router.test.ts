import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { EngineRouter } from "../src/engine/engine-router.js";
import { SourceSessionRegistry } from "../src/engine/source-session-registry.js";
import { resolveDesktopSourceBinding } from "../src/desktop/source-router.js";

describe("Engine Router and Source Session Registry", () => {
  it("deduplicates one site, shares initialization, reference-counts leases, and reclaims idle sessions", async () => {
    const destroy = vi.fn();
    const factory = vi.fn(() => ({ destroy }));
    const registry = new SourceSessionRegistry<{ destroy: () => void }>({ idleMs: 0, maxActiveSessions: 2 });
    const first = await registry.acquire("source\u0000site", factory);
    const second = await registry.acquire("source\u0000site", factory);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(registry.get("source\u0000site")).toMatchObject({ refs: 2, state: "ready" });

    let initCalls = 0;
    await Promise.all([
      first.init(async () => { initCalls += 1; }),
      second.init(async () => { initCalls += 1; }),
    ]);
    expect(initCalls).toBe(1);

    await first.release();
    expect(destroy).not.toHaveBeenCalled();
    await second.release();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(registry.get("source\u0000site")).toBeUndefined();
  });

  it("enforces the active-session limit and cleans all engines on exit", async () => {
    const registry = new SourceSessionRegistry<{ destroy: () => void }>({ maxActiveSessions: 1, idleMs: 0 });
    const first = await registry.acquire("a", () => ({ destroy: vi.fn() }));
    let secondResolved = false;
    const secondPromise = registry.acquire("b", () => ({ destroy: vi.fn() })).then(() => {
      secondResolved = true;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    await first.release();
    await secondPromise;
    expect(secondResolved).toBe(true);
    await registry.destroyAll();
    expect(registry.state()).toMatchObject({ active: 0, closed: true });
  });

  it("enforces the active-session limit while different sessions are still creating", async () => {
    const registry = new SourceSessionRegistry<{ destroy: () => void }>({ maxActiveSessions: 1, idleMs: 0 });
    let firstStarted!: () => void;
    let releaseFirstFactory!: () => void;
    const firstFactoryStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstFactoryRelease = new Promise<void>((resolve) => { releaseFirstFactory = resolve; });
    let created = 0;

    const firstPromise = registry.acquire("first", async () => {
      created += 1;
      firstStarted();
      await firstFactoryRelease;
      return { destroy: vi.fn() };
    });
    await firstFactoryStarted;

    let secondResolved = false;
    const secondPromise = registry.acquire("second", async () => {
      created += 1;
      return { destroy: vi.fn() };
    }).then((lease) => {
      secondResolved = true;
      return lease;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(created).toBe(1);
    expect(secondResolved).toBe(false);

    releaseFirstFactory();
    const first = await firstPromise;
    await first.release();
    const second = await secondPromise;
    expect(created).toBe(2);
    await second.release();
    expect(registry.state()).toMatchObject({ active: 0 });
  });

  it("unblocks pending creation and destroys an in-flight client during registry shutdown", async () => {
    const registry = new SourceSessionRegistry<{ destroy: () => void }>({ maxActiveSessions: 1, idleMs: 0 });
    let firstStarted!: () => void;
    let releaseFirstFactory!: () => void;
    const firstFactoryStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstFactoryRelease = new Promise<void>((resolve) => { releaseFirstFactory = resolve; });
    const firstDestroy = vi.fn();

    const firstPromise = registry.acquire("first", async () => {
      firstStarted();
      await firstFactoryRelease;
      return { destroy: firstDestroy };
    });
    await firstFactoryStarted;
    const secondPromise = registry.acquire("second", () => ({ destroy: vi.fn() }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const shutdown = registry.destroyAll();
    releaseFirstFactory();

    await expect(firstPromise).rejects.toMatchObject({ code: "SOURCE_SESSION_REGISTRY_CLOSED" });
    await expect(secondPromise).rejects.toMatchObject({ code: "SOURCE_SESSION_REGISTRY_CLOSED" });
    await shutdown;
    expect(firstDestroy).toHaveBeenCalledTimes(1);
    expect(registry.state()).toMatchObject({ active: 0, closed: true });
  });

  it("routes JVM, QuickJS and Python configuration without treating unknown csp_* as universal", () => {
    const jvm = resolveDesktopSourceBinding({ spider: "fixture.jar" }, {
      key: "douban",
      api: "csp_Douban",
    });
    expect(jvm).toMatchObject({ engine: "jvm", definition: { className: expect.any(String) } });

    const quickjs = resolveDesktopSourceBinding({}, { key: "js", api: "js:./spider.mjs" });
    expect(quickjs).toMatchObject({ engine: "quickjs", script: "./spider.mjs" });

    const python = resolveDesktopSourceBinding({}, { key: "py", api: "py:./spider.py" });
    expect(python).toMatchObject({ engine: "python", script: "./spider.py" });

    expect(resolveDesktopSourceBinding({}, { key: "unknown", api: "csp_Unknown" })).toBeUndefined();

    const router = new EngineRouter({ maxActiveSessions: 2, idleSessionMs: 0 });
    expect(router.key("inline:config", "douban", jvm!)).toBe("inline:config\u0000douban\u0000jvm\u0000csp_Douban");
  });

  it("routes Jellyfin through its specialized client and reports missing credentials explicitly", async () => {
    const binding = resolveDesktopSourceBinding({}, { key: "library", api: "jellyfin" });
    if (!binding) throw new Error("Jellyfin binding was not resolved");
    expect(binding).toMatchObject({ engine: "jellyfin", capabilities: { playback: true } });
    const router = new EngineRouter({ idleSessionMs: 0 });
    const runtime = {
      javaExecutable: "java",
      hostJar: "host.jar",
      spiderJar: "spider.jar",
      spiderClass: "fixture.Spider",
    };
    await expect(router.acquireClient(binding, {
      sourceId: "inline:config",
      siteKey: "library",
      sessionId: "jellyfin",
      binding,
    }, runtime)).rejects.toMatchObject({ code: "JELLYFIN_CONFIG_UNAVAILABLE" });

    const configured = {
      ...binding,
      jellyfinConfig: {
        baseUrl: "http://127.0.0.1:8096",
        token: "fixture-token",
        userId: "user-1",
      },
    };
    const client = await router.acquireClient(configured, {
      sourceId: "inline:config",
      siteKey: "library",
      sessionId: "jellyfin-configured",
      binding: configured,
    }, runtime);
    expect(client.capabilities).toMatchObject({ engine: "jellyfin", playback: true });
    await client.destroy();
  });

  it("shares one routed QuickJS client across site leases and releases it after the last user", async () => {
    const script = resolve("fixtures/spiders/echo.js");
    const binding = resolveDesktopSourceBinding({}, { key: "js", api: `js:${script}` });
    if (!binding) throw new Error("QuickJS test binding was not resolved");
    const router = new EngineRouter({ maxActiveSessions: 2, idleSessionMs: 0 });
    const runtime = {
      javaExecutable: "java",
      hostJar: "host.jar",
      spiderJar: "spider.jar",
      spiderClass: "fixture.Spider",
    };
    const first = await router.acquireClient(binding, {
      sourceId: "inline:config",
      siteKey: "js",
      sessionId: "first",
      binding,
    }, runtime);
    const second = await router.acquireClient(binding, {
      sourceId: "inline:config",
      siteKey: "js",
      sessionId: "second",
      binding,
    }, runtime);
    await Promise.all([first.init("one"), second.init("two")]);
    expect(router.state().sessions).toMatchObject([{ refs: 2 }]);
    await first.destroy();
    expect(router.state().sessions).toMatchObject([{ refs: 1 }]);
    await second.destroy();
    expect(router.state().active).toBe(0);
  });
});
