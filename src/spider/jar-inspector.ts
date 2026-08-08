import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { normalizeRuntimeError, type RuntimeErrorInfo } from "./runtime-errors.js";

export type JarRuntimeRequirement = "android-dex" | "jvm" | "mixed" | "unknown";

export interface JarInspectionResult {
  url: string;
  sha256: string;
  size: number;
  format: "jar" | "zip";
  hasClassesDex: boolean;
  hasJvmClasses: boolean;
  dexCount: number;
  classCount: number;
  nativeLibraries: readonly string[];
  assets: readonly string[];
  runtimeRequirement: JarRuntimeRequirement;
}

export class JarInspectionError extends Error {
  public readonly code = "invalid_jar";
  public readonly details: RuntimeErrorInfo | undefined;

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JarInspectionError";
    this.details = options?.cause ? normalizeRuntimeError(options.cause, { rootCause: "artifact_file_missing" }) : undefined;
  }
}

export class JarInspector {
  public async inspectFile(path: string, url = path): Promise<JarInspectionResult> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch (error) {
      throw new JarInspectionError(`Unable to read JAR: ${path}`, { cause: error });
    }
    return this.inspectBytes(bytes, url, path.toLowerCase().endsWith(".jar") ? "jar" : "zip");
  }

  public inspectBytes(bytes: Uint8Array, url: string, format?: "jar" | "zip"): JarInspectionResult {
    const names = readCentralDirectory(bytes);
    const hasClassesDex = names.some((name) => /^classes(?:\d+)?\.dex$/i.test(name));
    const hasJvmClasses = names.some((name) => /\.class$/i.test(name));
    const dexCount = names.filter((name) => /^classes(?:\d+)?\.dex$/i.test(name)).length;
    const classCount = names.filter((name) => /\.class$/i.test(name)).length;
    const nativeLibraries = names.filter((name) => /^lib\/.*\.(?:dll|so|dylib)$/i.test(name));
    const assets = names.filter((name) => /^assets\//i.test(name));
    const runtimeRequirement = hasClassesDex && hasJvmClasses
      ? "mixed"
      : hasClassesDex
        ? "android-dex"
        : hasJvmClasses
          ? "jvm"
          : "unknown";
    return {
      url,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      format: format ?? (/\.jar(?:$|[?#])/i.test(url) ? "jar" : "zip"),
      hasClassesDex,
      hasJvmClasses,
      dexCount,
      classCount,
      nativeLibraries,
      assets,
      runtimeRequirement,
    };
  }
}

function readCentralDirectory(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  if (endOffset < 0 || endOffset + 22 > view.byteLength) throw new JarInspectionError("JAR end record is missing");
  const entries = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (centralOffset + centralSize > view.byteLength) throw new JarInspectionError("JAR central directory is outside the file");
  const names: string[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > view.byteLength || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new JarInspectionError("JAR central directory entry is invalid");
    }
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > view.byteLength) throw new JarInspectionError("JAR central directory entry is truncated");
    names.push(new TextDecoder().decode(bytes.slice(nameStart, nameStart + nameLength)));
    cursor = next;
  }
  if (cursor > centralOffset + centralSize) throw new JarInspectionError("JAR central directory size is invalid");
  return names;
}

function findEndOfCentralDirectory(view: DataView): number {
  const start = Math.max(0, view.byteLength - 22 - 65_535);
  for (let offset = view.byteLength - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}
