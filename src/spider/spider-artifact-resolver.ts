import { existsSync } from "node:fs";

import type { TvBoxConfig, TvBoxSite } from "../config/decoder.js";
import { resolveFongMiReference } from "../config/fongmi.js";

export interface SpiderArtifactReference {
  spiderUrl?: string;
  jarUrl?: string;
  md5?: string;
}

export class SpiderArtifactResolver {
  public resolve(site: TvBoxSite, config?: TvBoxConfig, sourceUrl?: string): SpiderArtifactReference {
    const spider = text(config?.spider);
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
      return {
        ...(spiderUrl ? { spiderUrl } : {}),
        jarUrl: reference,
        ...(declaration.md5 ? { md5: declaration.md5 } : {}),
      };
    }
    return spiderUrl ? { spiderUrl } : {};
  }
}

function parseDeclaration(value: string): { reference: string; md5?: string } {
  const parts = value.split(";").map((part) => part.trim());
  const reference = parts[0] ?? "";
  const hash = parts[2] ?? "";
  return {
    reference,
    ...(parts[1]?.toLowerCase() === "md5" && /^[\da-f]{32}$/i.test(hash) ? { md5: hash.toLowerCase() } : {}),
  };
}

function declarationValue(value: string): string {
  return parseDeclaration(value).reference;
}

function resolveReference(value: string, sourceUrl?: string): string | undefined {
  return resolveFongMiReference(value, sourceUrl) ?? (isLocalOrUrl(value) ? value : undefined);
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
