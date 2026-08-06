import { afterEach, describe, expect, it } from "vitest";

import type { DesktopSpiderPlaybackState, DesktopSpiderSessionPort, DesktopSpiderView } from "../src/desktop/spider-ui.js";
import { DesktopSpiderUiController } from "../src/desktop/spider-ui.js";
import type { SpiderResponse } from "../src/spider/rpc.js";

describe("desktop playback health and fallback integration", () => {
  const controllers: DesktopSpiderUiController[] = [];

  afterEach(async () => {
    while (controllers.length > 0) await controllers.pop()?.close();
  });

  it("keeps a playerContent failure explainable in prompt mode and recovers after approval", async () => {
    const session = new FallbackSession();
    const ui = new DesktopSpiderUiController({ session, playbackFallbackMode: "prompt", playbackFallbackMaxAttempts: 2 });
    controllers.push(ui);
    ui.confirmImport();
    await ui.open("fixture", "fixture");

    const failed = await ui.player("主线", "retryable");
    expect(failed).toMatchObject({
      error: { code: "PLAYBACK_UPSTREAM_ERROR" },
      fallback: {
        mode: "prompt",
        status: "prompt",
        trigger: "player-content-failure",
        next: { id: "current-retry" },
      },
      playbackHealth: { resolveSuccess: { value: false }, score: { value: expect.any(Number) } },
    });

    const recovered = await ui.approveFallback();
    expect(session.playerCalls).toEqual(["retryable", "retryable"]);
    expect(recovered).toMatchObject({
      error: null,
      player: { status: "loading", source: { url: "https://media.example.invalid/recovered.m3u8" } },
      fallback: { status: "recovered", attempts: 1 },
    });
  });

  it("automatically retries the current line after consecutive segment failures", async () => {
    const session = new FallbackSession();
    const ui = new DesktopSpiderUiController({ session, playbackFallbackMode: "auto", playbackFallbackMaxAttempts: 2 });
    controllers.push(ui);
    ui.confirmImport();
    await ui.open("fixture", "fixture");
    await ui.player("主线", "stable");

    expect(ui.syncPlayerState({ event: { type: "segment-failure", reason: "fixture" } }).fallback.status).toBe("idle");
    ui.syncPlayerState({ event: { type: "segment-failure", reason: "fixture" } });
    await waitForAsyncFallback();

    expect(session.playerCalls).toEqual(["stable", "stable"]);
    expect(ui.state.fallback.status).toBe("recovered");
    expect(ui.state.playbackHealth.segmentFailure.value).toBe(2);
  });

  it("does not switch on user pause, seek, or one short buffer", async () => {
    const session = new FallbackSession();
    const ui = new DesktopSpiderUiController({ session, playbackFallbackMode: "auto" });
    controllers.push(ui);
    ui.confirmImport();
    await ui.open("fixture", "fixture");
    await ui.player("主线", "stable");

    ui.syncPlayerState({ event: { type: "user-pause" } });
    ui.syncPlayerState({ event: { type: "seek" } });
    ui.syncPlayerState({ event: { type: "buffer-start" } });
    const state = ui.syncPlayerState({ event: { type: "buffer-end" } });
    await waitForAsyncFallback();

    expect(session.playerCalls).toEqual(["stable"]);
    expect(state.fallback.status).toBe("idle");
    expect(ui.state.playbackHealth.bufferingCount.value).toBe(1);
  });
});

class FallbackSession implements DesktopSpiderSessionPort {
  public readonly playerCalls: string[] = [];
  public readonly view: DesktopSpiderView;
  private readonly attempts = new Map<string, number>();

  public constructor() {
    this.view = {
      source: "inline:fixture",
      api: "csp_FallbackFixture",
      status: "confirmation_required",
      warning: "confirm",
      error: null,
      sidecarRunning: false,
      playback: unavailablePlayback(),
    };
  }

  public confirmImport(): void {
    this.view.status = "idle";
    this.view.warning = null;
  }

  public async open(): Promise<SpiderResponse> {
    this.view.status = "ready";
    this.view.sidecarRunning = true;
    return ok({});
  }

  public async homeContent(): Promise<SpiderResponse> { return ok({ list: [] }); }
  public async categoryContent(): Promise<SpiderResponse> { return ok({ list: [] }); }
  public async searchContent(): Promise<SpiderResponse> { return ok({ list: [] }); }
  public async detailContent(): Promise<SpiderResponse> { return ok({ list: [] }); }

  public async playerContent(_flag: string, id: string): Promise<SpiderResponse> {
    this.playerCalls.push(id);
    const attempt = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempt);
    if (attempt === 1 && id === "retryable") {
      return { id: "fixture", ok: false, error: { code: "PLAYBACK_UPSTREAM_ERROR", message: "retryable failure" } };
    }
    this.view.playback = {
      available: true,
      label: "Fallback fixture",
      message: "resolved",
      parse: 0,
      url: "https://media.example.invalid/recovered.m3u8",
      headers: {},
    };
    return ok({ parse: 0, url: this.view.playback.url, header: {} });
  }

  public async stopPlayback(): Promise<void> {}
  public async destroy(): Promise<void> {
    this.view.status = "destroyed";
    this.view.sidecarRunning = false;
  }
}

function unavailablePlayback(): DesktopSpiderPlaybackState {
  return { available: false, label: "fixture", message: "not loaded" };
}

function ok(result: unknown): SpiderResponse {
  return { id: "fixture", ok: true, result };
}

async function waitForAsyncFallback(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
