import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { ImportTrustStore, inspectImport } from "../src/config/trust.js";
import { DesktopSpiderSession } from "../src/desktop/spider-session.js";
import { QuickJsEngine } from "../src/spider/quickjs-engine.js";
import { QuickJsDesktopClient } from "../src/spider/quickjs-client.js";
import { QuickJsMediaSource } from "../src/spider/quickjs-source.js";
import { JsSpiderRuntime } from "../src/spider/spider-runtime.js";
import { runtimeCapabilities } from "../src/spider/runtime-types.js";

const request = (value: { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number }) => ({
  url: value.url,
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ list: [{ vod_id: "remote-1", vod_name: "Remote" }] }),
});

describe("QuickJS Spider engine", () => {
  it("runs ESM, __jsEvalReturn, synchronous req, and the full source contract", async () => {
    const source = new QuickJsMediaSource({
      api: "js:fixture",
      script: `
        const state = { ext: "" };
        const spider = {
          init(ext) { state.ext = ext; },
          home() { return { class: [{ type_id: "movie", type_name: "Movie" }], list: [{ vod_id: "home-1", vod_name: state.ext }] }; },
          category(typeId, page, filter, extend) { return { page, list: [{ vod_id: typeId, vod_name: extend.tag || String(filter) }] }; },
          search(key, quick, page) { return { page, list: [{ vod_id: key, vod_name: quick ? "quick" : "normal" }] }; },
          detail(ids) { return { list: ids.map((id) => ({ vod_id: id, vod_name: "Detail" })) }; },
          player(flag, id) { return { parse: 0, url: "https://media.example.invalid/" + id + ".mp4", header: { "X-Flag": flag } }; },
          localProxy(request) { return { url: request.url, status: 200, headers: {}, body: "proxy-ok" }; },
          remote() { return JSON.parse(req("https://api.example.invalid/catalog", { method: "POST", headers: { "X-Test": "yes" }, body: "body", timeoutMs: 50 })); },
        };
        export function __jsEvalReturn() { return spider; }
        export default spider;
      `,
      allowedOrigins: ["https://api.example.invalid"],
      request,
    });

    expect(source.capabilities).toMatchObject({ engine: "quickjs", playback: false });
    await source.init({ sourceId: "inline:quickjs", siteKey: "quick", ext: "fixture-ext" });
    expect(source.capabilities).toMatchObject({
      home: true,
      category: true,
      search: true,
      detail: true,
      playback: true,
      localProxy: true,
      engine: "quickjs",
    });
    await expect(source.home()).resolves.toMatchObject({ items: [{ id: "home-1", name: "fixture-ext" }] });
    await expect(source.category({ typeId: "movie", page: 2, filter: true, extend: { tag: "filtered" } }))
      .resolves.toMatchObject({ page: 2, items: [{ id: "movie", name: "filtered" }] });
    await expect(source.search({ key: "search", quick: true })).resolves.toMatchObject({
      items: [{ id: "search", name: "quick" }],
    });
    await expect(source.detail(["detail-1"])).resolves.toMatchObject([{ id: "detail-1" }]);
    await expect(source.player({ flag: "main", id: "movie-1" })).resolves.toMatchObject({
      parse: 0,
      url: "https://media.example.invalid/movie-1.mp4",
      headers: { "X-Flag": "main" },
    });
    await expect(source.localProxy({ url: "https://api.example.invalid/proxy" })).resolves.toMatchObject({
      status: 200,
      body: new TextEncoder().encode("proxy-ok"),
    });
    await source.destroy();
    await source.destroy();
  });

  it("supports plain scripts and ESM dependency maps without exposing Node APIs", async () => {
    const engine = new QuickJsEngine({
      script: `
        const spider = {
          init() { return { process: typeof process, require: typeof require, fs: typeof fs }; },
          bridge() {
            localStorage.setItem("token", "fixture");
            return {
              fetch: typeof fetch,
              post: typeof post,
              encode: encode("fixture"),
              decode: decode("Zml4dHVyZQ=="),
              hash: hash("fixture"),
              stored: localStorage.getItem("token"),
            };
          },
        };
      `,
    });
    await engine.init();
    await expect(engine.call("init")).resolves.toEqual({ process: "undefined", require: "undefined", fs: "undefined" });
    await expect(engine.call("bridge")).resolves.toMatchObject({
      fetch: "function",
      post: "function",
      encode: "Zml4dHVyZQ==",
      decode: "fixture",
      hash: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      stored: "fixture",
    });
    await engine.destroy();

    const moduleEngine = new QuickJsEngine({
      script: `export { default } from "./dep.js";`,
      moduleSources: {
        "./dep.js": `export default { init() { return "dependency-ok"; } };`,
      },
    });
    await moduleEngine.init();
    await expect(moduleEngine.call("init")).resolves.toBe("dependency-ok");
    await moduleEngine.destroy();
  });

  it("interrupts an infinite loop and releases the QuickJS session", async () => {
    const engine = new QuickJsEngine({
      script: `export default { init() { while (true) {} } };`,
      maxExecutionMs: 50,
    });
    await engine.init();
    await expect(engine.call("init")).rejects.toMatchObject({ code: "QUICKJS_TIMEOUT" });
    expect(engine.lastError?.code).toBe("QUICKJS_TIMEOUT");
    await engine.destroy();
    expect(engine.status).toBe("stopped");
  });

  it("imports a JavaScript file through the desktop session and reaches playback", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-quickjs-session-"));
    const scriptPath = join(directory, "playable.mjs");
    writeFileSync(scriptPath, `export default {
      init() {},
      home() { return { list: [] }; },
      player(flag, id) { return { parse: 0, url: "https://media.example.invalid/" + id + ".mp4", header: {} }; },
    };`);
    const api = `js:${scriptPath}`;
    const trustStore = new ImportTrustStore();
    const config = { sites: [{ key: "js", api, ext: "fixture" }] };
    trustStore.trustAssessment(inspectImport("inline:quickjs-session", config, trustStore));
    const session = new DesktopSpiderSession({
      source: "inline:quickjs-session",
      config,
      trustStore,
      createClient: (site, context) => new QuickJsDesktopClient({
        api: site.api ?? api,
        script: context?.binding.script ?? scriptPath,
      }),
    });
    try {
      await expect(session.open("js", "fixture")).resolves.toMatchObject({ ok: true });
      expect(session.view.capabilities).toMatchObject({ engine: "quickjs", playback: true });
      await expect(session.playerContent("default", "movie-1")).resolves.toMatchObject({
        ok: true,
        result: { url: "https://media.example.invalid/movie-1.mp4" },
      });
      expect(session.view.playback).toMatchObject({ available: true });
    } finally {
      await session.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("routes the desktop session contract through SpiderRuntime when a runtime factory is supplied", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-quickjs-runtime-session-"));
    const scriptPath = join(directory, "runtime.mjs");
    writeFileSync(scriptPath, `export default {
      init() {},
      home() { return { list: [{ vod_id: "home-1", vod_name: "Home" }] }; },
      search(key) { return { list: [{ vod_id: key, vod_name: "Search" }] }; },
      detail(ids) { return { list: [{ vod_id: ids[0], vod_name: "Detail" }] }; },
      player(flag, id) { return { parse: 0, url: "https://media.example.invalid/" + id + ".mp4", header: { "X-Flag": flag } }; },
    };`);
    const api = `js:${scriptPath}`;
    const trustStore = new ImportTrustStore();
    const config = { sites: [{ key: "runtime", api, ext: "fixture" }] };
    trustStore.trustAssessment(inspectImport("inline:quickjs-runtime-session", config, trustStore));
    const session = new DesktopSpiderSession({
      source: "inline:quickjs-runtime-session",
      config,
      trustStore,
      createClient: () => { throw new Error("legacy client should not be used"); },
      createRuntime: (site) => new JsSpiderRuntime(site, {
        runtime: "javascript",
        supported: true,
        reason: "js_supported",
        capabilities: runtimeCapabilities("quickjs", { home: true, search: true, detail: true, player: true }),
      }, { script: scriptPath, timeoutMs: 2_000 }),
    });
    try {
      await expect(session.open("runtime", "fixture")).resolves.toMatchObject({ ok: true });
      await expect(session.homeContent()).resolves.toMatchObject({ ok: true, result: { list: [{ vod_id: "home-1" }] } });
      await expect(session.searchContent("movie")).resolves.toMatchObject({ ok: true, result: { list: [{ vod_id: "movie" }] } });
      await expect(session.detailContent(["movie"])).resolves.toMatchObject({ ok: true, result: { list: [{ vod_id: "movie" }] } });
      await expect(session.playerContent("main", "movie")).resolves.toMatchObject({ ok: true, result: { url: "https://media.example.invalid/movie.mp4" } });
    } finally {
      await session.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
