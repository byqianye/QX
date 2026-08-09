import type { TvBoxSite } from "../config/decoder.js";

export const VALIDATED_ANDROID_DEX_SITE_KEY = "csp_FeiMaoUC";
export const VALIDATED_ANDROID_DEX_API = "csp_Duopan";

/**
 * The first Android DEX integration is intentionally source-specific. A real
 * device PoC exists for this exact configured site/API pair; other DEX sources
 * must not inherit its capability claim.
 */
export function isValidatedAndroidDexSite(site: TvBoxSite): boolean {
  return site.key?.trim().toLowerCase() === VALIDATED_ANDROID_DEX_SITE_KEY.toLowerCase()
    && site.api?.trim().toLowerCase() === VALIDATED_ANDROID_DEX_API.toLowerCase();
}
