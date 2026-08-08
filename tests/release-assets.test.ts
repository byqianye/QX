import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("release brand assets", () => {
  it("generates a valid six-size PNG-backed ICO", () => {
    execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/release/generate-brand-assets.ts"], {
      cwd: projectRoot,
      stdio: "ignore",
    });

    const ico = readFileSync(join(projectRoot, "build", "assets", "qx-yingshi.ico"));
    const sizes = [256, 128, 64, 48, 32, 16];
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(sizes.length);

    sizes.forEach((size, index) => {
      const entry = 6 + index * 16;
      const offset = ico.readUInt32LE(entry + 12);
      const length = ico.readUInt32LE(entry + 8);
      expect(ico[entry] ?? 0).toBe(size === 256 ? 0 : size);
      expect(ico[entry + 1] ?? 0).toBe(size === 256 ? 0 : size);
      expect(ico.subarray(offset, offset + 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(ico.readUInt32BE(offset + 16)).toBe(size);
      expect(ico.readUInt32BE(offset + 20)).toBe(size);
      expect(offset + length).toBeLessThanOrEqual(ico.length);
    });
  });
});
