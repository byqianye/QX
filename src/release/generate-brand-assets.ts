import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outputDirectory = join(process.cwd(), "build", "assets");
const sizes = [256, 128, 64, 48, 32, 16] as const;

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, "qx-yingshi-mark.svg"), brandSvg(), "utf8");
writeFileSync(join(outputDirectory, "qx-yingshi.ico"), createIco(sizes));

function brandSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="QX影视">
  <circle cx="128" cy="128" r="96" fill="#111111"/>
  <circle cx="128" cy="128" r="54" fill="none" stroke="#ffffff" stroke-width="18"/>
  <path d="M158 158 194 194" fill="none" stroke="#2f6feb" stroke-linecap="round" stroke-width="18"/>
  <path d="M76 74 180 178M180 74 76 178" fill="none" stroke="#ffffff" stroke-linecap="round" stroke-width="10" opacity=".92"/>
</svg>`;
}

function createIco(iconSizes: readonly number[]): Buffer {
  const pngs = iconSizes.map((size) => createPng(size));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = Buffer.alloc(pngs.length * 16);
  let offset = header.length + entries.length;
  pngs.forEach((png, index) => {
    const size = iconSizes[index];
    if (!size) throw new Error("Brand icon size is missing");
    entries.writeUInt8(size === 256 ? 0 : size, index * 16);
    entries.writeUInt8(size === 256 ? 0 : size, index * 16 + 1);
    entries.writeUInt16LE(1, index * 16 + 4);
    entries.writeUInt16LE(32, index * 16 + 6);
    entries.writeUInt32LE(png.length, index * 16 + 8);
    entries.writeUInt32LE(offset, index * 16 + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...pngs]);
}

function createPng(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const outer = size * 0.38;
  const inner = size * 0.25;
  const ringWidth = Math.max(2, size * 0.085);
  const setPixel = (x: number, y: number, color: readonly number[]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const index = (y * size + x) * 4;
    pixels[index] = color[0] ?? 0;
    pixels[index + 1] = color[1] ?? 0;
    pixels[index + 2] = color[2] ?? 0;
    pixels[index + 3] = color[3] ?? 0;
  };
  const dark = [17, 17, 17, 255] as const;
  const white = [255, 255, 255, 255] as const;
  const accent = [47, 111, 235, 255] as const;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      if (distance <= outer) setPixel(x, y, dark);
      if (distance > inner && distance < inner + ringWidth) setPixel(x, y, white);
    }
  }
  drawLine(pixels, size, center + inner * 0.45, center + inner * 0.45, center + outer * 0.72, center + outer * 0.72, accent, Math.max(2, size * 0.09));
  drawLine(pixels, size, center - outer * 0.48, center - outer * 0.48, center + outer * 0.48, center + outer * 0.48, white, Math.max(1, size * 0.045));
  drawLine(pixels, size, center + outer * 0.48, center - outer * 0.48, center - outer * 0.48, center + outer * 0.48, white, Math.max(1, size * 0.045));
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawLine(pixels: Buffer, size: number, x1: number, y1: number, x2: number, y2: number, color: readonly number[], width: number): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2));
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    const x = x1 + (x2 - x1) * progress;
    const y = y1 + (y2 - y1) * progress;
    const radius = Math.max(0.5, width / 2);
    for (let py = Math.floor(y - radius); py <= Math.ceil(y + radius); py += 1) {
      for (let px = Math.floor(x - radius); px <= Math.ceil(x + radius); px += 1) {
        if (px < 0 || py < 0 || px >= size || py >= size || Math.hypot(px - x, py - y) > radius) continue;
        const index = (py * size + px) * 4;
        pixels[index] = color[0] ?? 0;
        pixels[index + 1] = color[1] ?? 0;
        pixels[index + 2] = color[2] ?? 0;
        pixels[index + 3] = color[3] ?? 0;
      }
    }
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
