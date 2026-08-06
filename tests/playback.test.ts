import { describe, expect, it } from "vitest";

import {
  EmbeddedPlaybackController,
  type PlaybackSource,
} from "../src/desktop/playback.js";

describe("embedded playback controller", () => {
  const mp4: PlaybackSource = {
    parse: 0,
    url: "http://127.0.0.1:43123/media/fixture.mp4",
    headers: {},
  };

  it("tracks the direct MP4 lifecycle and controls", () => {
    const player = new EmbeddedPlaybackController();

    expect(player.state).toMatchObject({
      status: "idle",
      source: null,
      currentTime: 0,
      volume: 1,
      muted: false,
      fullscreen: false,
    });

    expect(player.load(mp4)).toMatchObject({
      status: "loading",
      source: mp4,
    });
    expect(player.play().status).toBe("playing");
    expect(player.pause().status).toBe("paused");
    expect(player.resume().status).toBe("playing");

    player.setDuration(90);
    expect(player.seek(42)).toMatchObject({ currentTime: 42, duration: 90 });
    expect(player.seek(999).currentTime).toBe(90);
    expect(player.setVolume(0.35).volume).toBeCloseTo(0.35);
    expect(player.setMuted(true).muted).toBe(true);
    expect(player.setFullscreen(true).fullscreen).toBe(true);
    expect(player.markEnded().status).toBe("ended");
    expect(player.reload().status).toBe("loading");
    expect(player.stop()).toMatchObject({ status: "stopped", source: null, currentTime: 0 });
  });

  it("rejects custom headers instead of silently dropping them", () => {
    const player = new EmbeddedPlaybackController();

    expect(player.load({
      ...mp4,
      headers: { Referer: "https://source.example.invalid/" },
    })).toMatchObject({
      status: "error",
      source: null,
      error: { code: "PLAYBACK_PROXY_REQUIRED" },
    });
  });

  it("rejects parse modes other than direct playback", () => {
    const player = new EmbeddedPlaybackController();

    expect(player.load({ ...mp4, parse: 1 })).toMatchObject({
      status: "error",
      error: { code: "PLAYBACK_PARSE_UNSUPPORTED" },
    });
  });

  it("maps media errors and can recover by reloading the source", () => {
    const player = new EmbeddedPlaybackController();
    player.load(mp4);

    expect(player.markError("MEDIA_LOAD_ERROR", "fixture failed")).toMatchObject({
      status: "error",
      error: { code: "MEDIA_LOAD_ERROR", message: "fixture failed" },
    });
    expect(player.reload().status).toBe("loading");
  });

  it("accepts renderer media errors without losing the original error code", () => {
    const player = new EmbeddedPlaybackController();
    player.load(mp4);

    expect(player.syncMedia({
      status: "error",
      error: { code: "HLS_ERROR", message: "HLS 播放失败" },
    })).toMatchObject({
      status: "error",
      error: { code: "HLS_ERROR", message: "HLS 播放失败" },
    });
  });
});
