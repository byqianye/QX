import { describe, expect, it } from "vitest";

import { normalizeMpegTsForBrowser } from "../src/desktop/playback-proxy.js";

describe("normalizeMpegTsForBrowser", () => {
  it("removes detected multichannel AAC while preserving the video PID and TS alignment", () => {
    const input = Buffer.concat([
      tsPacket(0, true, Buffer.from([0, 0, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0])),
      tsPacket(0x1000, true, Buffer.from([0, 2, 0xb0, 0x17, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x01, 0xf0, 0x00, 0x0f, 0xe1, 0x02, 0xf0, 0x00, 0, 0, 0, 0])),
      tsPacket(0x101, true, Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 0x05, 0, 0, 0, 0, 0, 0x65, 0, 0, 0, 0])),
      tsPacket(0x102, true, Buffer.from([0, 0, 1, 0xc0, 0, 0, 0x80, 0x80, 0x05, 0, 0, 0, 0, 0, 0xff, 0xf1, 0x4c, 0x00, 0, 0])),
      tsPacket(0x101, false, Buffer.alloc(32, 0x11)),
      tsPacket(0x101, false, Buffer.alloc(32, 0x22)),
      tsPacket(0x101, false, Buffer.alloc(32, 0x33)),
      tsPacket(0x101, false, Buffer.alloc(32, 0x44)),
      tsPacket(0x101, false, Buffer.alloc(32, 0x55)),
    ]);
    const output = normalizeMpegTsForBrowser(input);

    expect(output).toBeDefined();
    expect(output?.length).toBe(8 * 188);
    expect(output && output.length % 188).toBe(0);
    expect(output ? tsPids(output) : []).not.toContain(0x102);
    expect(output ? tsPids(output) : []).toContain(0x101);
  });

  it("leaves a stereo AAC segment unchanged", () => {
    const audio = tsPacket(0x102, true, Buffer.from([0, 0, 1, 0xc0, 0, 0, 0x80, 0x80, 0x05, 0, 0, 0, 0, 0, 0xff, 0xf1, 0x4c, 0x80, 0, 0]));
    const input = Buffer.concat([
      tsPacket(0, true, Buffer.from([0, 0, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0])),
      tsPacket(0x1000, true, Buffer.from([0, 2, 0xb0, 0x17, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x01, 0xf0, 0x00, 0x0f, 0xe1, 0x02, 0xf0, 0x00, 0, 0, 0, 0])),
      tsPacket(0x101, true, Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 0x05, 0, 0, 0, 0, 0, 0x65])),
      audio,
    ]);

    expect(normalizeMpegTsForBrowser(input)).toBeUndefined();
  });
});

function tsPacket(pid: number, payloadStart: boolean, payload: Buffer): Buffer {
  const packet = Buffer.alloc(188, 0xff);
  packet[0] = 0x47;
  packet[1] = ((payloadStart ? 0x40 : 0) | ((pid >> 8) & 0x1f));
  packet[2] = pid & 0xff;
  packet[3] = 0x10;
  payload.copy(packet, 4);
  return packet;
}

function tsPids(input: Buffer): number[] {
  const pids: number[] = [];
  for (let offset = 0; offset < input.length; offset += 188) {
    pids.push(((input[offset + 1]! & 0x1f) << 8) | input[offset + 2]!);
  }
  return pids;
}
