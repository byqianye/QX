import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { TvBoxConfig, TvBoxSite } from "../config/decoder.js";
import { resolveFongMiReference } from "../config/fongmi.js";
import { SpiderArtifactError, type SpiderArtifactCache } from "./spider-artifact-cache.js";

export interface SpiderArtifactReference {
  spiderUrl?: string;
  jarUrl?: string;
  md5?: string;
}

export interface ResolvedSpiderArtifact {
  originalDeclaration: string;
  artifactUrl: string;
  localPath: string;
  sha256: string;
  size: number;
  cacheHit: boolean;
  md5?: string;
}

export class SpiderArtifactResolver {
  public resolve(site: TvBoxSite, config?: TvBoxConfig, sourceUrl?: string): SpiderArtifactReference {
    const spider = text(config?.spider);
    const siteMd5 = md5Value(site.md5) ?? md5Value(site.hash);
    const candidates = [
      { value: text(site.jar), artifact: true },
      { value: text(site.spider), artifact: true },
      { value: spider, artifact: true },
    ];
    const spiderUrl = spider ? resolveReference(declarationValue(spider), sourceUrl) : undefined;
    for (const candidate of candidates) {
      if (!candidate.value) continue;
      const declaration = parseDeclaration(candidate.value);
      const reference = resolveReference(declaration.reference, sourceUrl) ?? declaration.reference;
      if (!isArtifactReference(reference, site)) continue;
      const md5 = declaration.md5 ?? siteMd5;
      return {
        ...(spiderUrl ? { spiderUrl } : {}),
        jarUrl: reference,
        ...(md5 ? { md5 } : {}),
      };
    }
    return spiderUrl ? { spiderUrl } : {};
  }

  public async resolveSpiderArtifact(
    configUrl: string | undefined,
    spiderDeclaration: string,
    cache?: SpiderArtifactCache,
  ): Promise<ResolvedSpiderArtifact> {
    const originalDeclaration = spiderDeclaration.trim();
    const declaration = parseDeclaration(originalDeclaration);
    const resolved = resolveSpiderReference(configUrl, declaration.reference);
    if (!resolved) throw new Error(`Unable to resolve Spider artifact reference: ${declaration.reference}`);
    if (/^https?:\/\//i.test(resolved)) {
      if (!cache) throw new SpiderArtifactError("jar_download_failed", `Spider artifact cache is unavailable: ${resolved}`);
      const artifact = await cache.get({ url: resolved, ...(declaration.md5 ? { md5: declaration.md5 } : {}) });
      return {
        originalDeclaration,
        artifactUrl: resolved,
        localPath: artifact.path,
        sha256: artifact.sha256,
        size: artifact.size,
        cacheHit: artifact.fromCache,
        ...(declaration.md5 ? { md5: declaration.md5 } : {}),
      };
    }
    const localPath = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
    const [bytes, file] = await Promise.all([readFile(localPath), stat(localPath)]);
    const actualMd5 = createHash("md5").update(bytes).digest("hex");
    if (declaration.md5 && actualMd5 !== declaration.md5) {
      throw new SpiderArtifactError("jar_hash_mismatch", `Spider artifact MD5 mismatch: ${localPath}`);
    }
    return {
      originalDeclaration,
      artifactUrl: pathToFileURL(localPath).toString(),
      localPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: file.size,
      cacheHit: true,
      ...(declaration.md5 ? { md5: actualMd5 } : {}),
    };
  }
}

function parseDeclaration(value: string): { reference: string; md5?: string } {
  const normalized = value.trim();
  const declared = /^(.*);md5;([\da-f]{32})$/iu.exec(normalized);
  return {
    reference: declared?.[1]?.trim() ?? normalized,
    ...(declared?.[2] ? { md5: declared[2].toLowerCase() } : {}),
  };
}

function md5Value(value: unknown): string | undefined {
  return typeof value === "string" && /^[\da-f]{32}$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined;
}

function declarationValue(value: string): string {
  return parseDeclaration(value).reference;
}

function resolveReference(value: string, sourceUrl?: string): string | undefined {
  const remote = resolveFongMiReference(value, sourceUrl);
  if (remote) return remote;
  if (sourceUrl && /^file:\/\//i.test(sourceUrl)) return resolveSpiderReference(sourceUrl, value);
  if (/^file:\/\//i.test(value) || isAbsolute(value) || isLocalOrUrl(value)) return value;
  return undefined;
}

function resolveSpiderReference(configUrl: string | undefined, value: string): string | undefined {
  if (/^https?:\/\//i.test(value)) return value;
  if (/^file:\/\//i.test(value)) return value;
  if (isAbsolute(value)) return value;
  if (configUrl && /^file:\/\//i.test(configUrl)) {
    return join(dirname(fileURLToPath(configUrl)), value);
  }
  if (configUrl && /^https?:\/\//i.test(configUrl)) {
    return new URL(value, configUrl).toString();
  }
  return resolve(value);
}

function isArtifactReference(value: string, site: TvBoxSite): boolean {
  return /^https?:\/\//i.test(value)
    || /\.(?:jar|dex)(?:$|[?#])/i.test(value)
    || existsSync(value)
    || (typeof site.api === "string" && /^csp_/i.test(site.api));
}

function isLocalOrUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || existsSync(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
