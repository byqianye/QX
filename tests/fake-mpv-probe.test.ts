import { describe, expect, it } from "vitest";

import { runFakeMpvExitProbe } from "../src/electron/fake-mpv-probe.js";

describe("packaged fake-mpv probe", () => {
  it("loads through the backend contract and exits cleanly", async () => {
    await expect(runFakeMpvExitProbe()).resolves.toBe(true);
  });
});
