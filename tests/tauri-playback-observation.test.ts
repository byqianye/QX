import { describe, expect, it } from "vitest";
import { playbackObservationFailures } from "../scripts/tauri-playback-observation.js";

describe("continuous desktop playback evidence", () => {
  const passed = () => ({ intentAt: 0, firstFrameAt: 1800, frames: 14000, firstTime: 0.1, lastTime: 601,
    maxFrameGapMs: 120, bufferCount: 0, bufferingAt: null, ended: false, errors: [],
    samples: [{ elapsedMs: 600000, time: 600, rate: 1, paused: false }] });
  it("requires decoded frames and wall-clock playback at normal speed", () => {
    expect(playbackObservationFailures(passed(), 600)).toEqual([]);
    expect(playbackObservationFailures({ ...passed(), frames: 0 }, 600)).toContain("NO_DECODED_FRAME");
    expect(playbackObservationFailures({ ...passed(), lastTime: 6.687 }, 600)).toContain("CONTINUOUS_PLAYBACK_TOO_SHORT");
    expect(playbackObservationFailures({ ...passed(), samples: [{ elapsedMs: 10000, time: 600, rate: 60, paused: false }] }, 600)).toContain("CONTINUOUS_PLAYBACK_TOO_SHORT");
  });
  it("rejects late startup, buffering, frame stalls, pause and early endings", () => {
    expect(playbackObservationFailures({ ...passed(), firstFrameAt: 11000 }, 600)).toContain("FIRST_FRAME_OVER_10S");
    expect(playbackObservationFailures({ ...passed(), bufferCount: 1 }, 600)).toContain("BUFFERING_INTERRUPTION");
    expect(playbackObservationFailures({ ...passed(), maxFrameGapMs: 8000 }, 600)).toContain("BUFFERING_INTERRUPTION");
    expect(playbackObservationFailures({ ...passed(), ended: true }, 600)).toContain("MEDIA_ENDED_OR_FAILED");
    expect(playbackObservationFailures({ ...passed(), samples: [{ elapsedMs: 600000, time: 600, rate: 1, paused: true }] }, 600)).toContain("PLAYBACK_NOT_CONTINUOUS_AT_1X");
  });
});
