import { readFileSync, statSync } from "node:fs";

import { JvmEngineError } from "./jvm-errors.js";

export type JvmArtifactKind = "jvm-jar" | "android-dex";

export function validateJvmSpiderArtifact(path: string): JvmArtifactKind {
  let bytes: Buffer;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw new Error("not a file");
    bytes = readFileSync(path);
  } catch (error) {
    throw new JvmEngineError(
      "JVM_ARTIFACT_NOT_FOUND",
      `JVM Spider artifact could not be read: ${path}`,
      { cause: error },
    );
  }

  if (looksLikeDex(bytes)) {
    throw new JvmEngineError(
      "ANDROID_DEX_UNSUPPORTED",
      "Android DEX Spider artifacts are not supported by the JVM URLClassLoader engine.",
    );
  }

  if (!looksLikeZip(bytes)) {
    throw new JvmEngineError(
      "JVM_ARTIFACT_INVALID",
      "JVM Spider artifact is not a valid Jar/Zip archive.",
    );
  }

  const entries = zipEntryNames(bytes);
  if (entries.some((entry) => /^classes\d*\.dex$/i.test(entry))) {
    throw new JvmEngineError(
      "ANDROID_DEX_UNSUPPORTED",
      "Android DEX Spider artifacts are not supported by the JVM URLClassLoader engine.",
    );
  }
  if (!entries.some((entry) => entry.endsWith(".class"))) {
    throw new JvmEngineError(
      "JVM_ARTIFACT_INVALID",
      "JVM Spider artifact does not contain JVM class files.",
    );
  }
  return "jvm-jar";
}

function looksLikeDex(bytes: Buffer): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x64
    && bytes[1] === 0x65
    && bytes[2] === 0x78
    && bytes[3] === 0x0a;
}

function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
    && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);
}

function zipEntryNames(bytes: Buffer): string[] {
  const end = findEndOfCentralDirectory(bytes);
  if (end < 0) return scanEntryNames(bytes);

  const count = bytes.readUInt16LE(end + 10);
  const centralOffset = bytes.readUInt32LE(end + 16);
  const names: string[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < count && cursor + 46 <= bytes.length; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) break;
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) break;
    names.push(bytes.subarray(nameStart, nameEnd).toString("utf8"));
    cursor = nameEnd + extraLength + commentLength;
  }
  return names.length > 0 ? names : scanEntryNames(bytes);
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const signature = 0x06054b50;
  const minimumSize = 22;
  for (let index = bytes.length - minimumSize; index >= 0; index -= 1) {
    if (bytes.readUInt32LE(index) === signature) return index;
  }
  return -1;
}

function scanEntryNames(bytes: Buffer): string[] {
  const text = bytes.toString("latin1");
  const names: string[] = [];
  for (const match of text.matchAll(/(?:^|[^\x20-\x7e])([A-Za-z0-9_./-]+\.(?:class|dex))(?:[^\x20-\x7e]|$)/g)) {
    const name = match[1];
    if (name) names.push(name);
  }
  return names;
}
