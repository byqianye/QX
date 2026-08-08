import { describe, expect, it } from "vitest";

import { JsSpiderWorker } from "../src/spider/js-spider-worker-client.js";

describe("JavaScript Spider worker runtime", () => {
  it("runs a Spider in an isolated worker and returns normalized capabilities", async () => {
    const worker = new JsSpiderWorker({
      script: `export default {
        init() {},
        search(key, quick, page) { return { page, list: [{ vod_id: key, vod_name: quick ? "quick" : "normal" }] }; },
        detail(ids) { return { list: ids.map((id) => ({ vod_id: id, vod_name: "Detail" })) }; },
      };`,
      timeoutMs: 2_000,
    });
    try {
      await worker.start({ sourceId: "worker-test", ext: "fixture" });
      expect(worker.capabilities).toMatchObject({ search: true, detail: true, engine: "quickjs" });
      await expect(worker.search({ key: "movie", quick: true, page: 2 })).resolves.toMatchObject({
        items: [{ id: "movie", name: "quick" }],
        page: 2,
      });
    } finally {
      await worker.destroy();
    }
  });

  it("terminates a worker that exceeds its execution timeout", async () => {
    const worker = new JsSpiderWorker({
      script: `export default { init() { while (true) {} } };`,
      timeoutMs: 100,
      maxExecutionMs: 100,
    });
    await expect(worker.start({ sourceId: "timeout-test" })).rejects.toMatchObject({
      code: "JS_WORKER_TIMEOUT",
    });
    expect(worker.state).toBe("failed");
    await worker.destroy();
  });

  it("contains a failed worker while another worker continues", async () => {
    const failed = new JsSpiderWorker({
      script: `export default { init() { throw new Error("broken spider"); } };`,
      timeoutMs: 1_000,
    });
    const healthy = new JsSpiderWorker({
      script: `export default { init() {}, search() { return { list: [{ vod_id: "ok", vod_name: "OK" }] }; } };`,
      timeoutMs: 1_000,
    });
    try {
      await expect(failed.start({ sourceId: "failed-test" })).rejects.toMatchObject({ code: "QUICKJS_SCRIPT_ERROR" });
      await healthy.start({ sourceId: "healthy-test" });
      await expect(healthy.search({ key: "ok" })).resolves.toMatchObject({ items: [{ id: "ok" }] });
    } finally {
      await failed.destroy();
      await healthy.destroy();
    }
  });
});
