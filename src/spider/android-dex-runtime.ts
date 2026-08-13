import type { TvBoxSite } from "../config/decoder.js";

/** Android DEX support is determined by the artifact/Host/class probe, never by site key. */
export function isAndroidDexSite(site: TvBoxSite): boolean {
  return site.type === 3 && typeof site.api === "string" && /^csp_/iu.test(site.api.trim());
}

export function expectedAndroidSpiderClass(api: string | undefined): string {
  const name = api?.trim().replace(/^csp_/iu, "");
  return name && /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)
    ? `com.github.catvod.spider.${name}`
    : "";
}

export interface AndroidDexCompatibilityFailure {
  siteKey: string;
  api: string;
  code: string;
  message?: string;
  observedAt: string;
}

/**
 * A failure cache is intentionally narrow: only an observed Host/artifact
 * failure can suppress a source, and callers can clear it after config/artifact
 * changes. “Not probed yet” is not a compatibility failure.
 */
export class AndroidDexCompatibilityRegistry {
  private readonly failures = new Map<string, AndroidDexCompatibilityFailure>();

  public record(failure: AndroidDexCompatibilityFailure): void {
    this.failures.set(failure.siteKey, failure);
  }

  public get(siteKey: string): AndroidDexCompatibilityFailure | undefined {
    return this.failures.get(siteKey);
  }

  public clear(siteKey?: string): void {
    if (siteKey === undefined) this.failures.clear();
    else this.failures.delete(siteKey);
  }

  public snapshot(): readonly AndroidDexCompatibilityFailure[] {
    return [...this.failures.values()];
  }
}
