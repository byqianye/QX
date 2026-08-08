import type { TvBoxSite } from "../config/decoder.js";
import { normalizeFongMiSite, type FongMiSiteConfig } from "../config/fongmi.js";

export interface ConfigSiteInspection {
  site: TvBoxSite;
  normalized: FongMiSiteConfig;
  index: number;
  siteKey: string;
  siteName: string;
  type: number;
  api: string;
  ext?: unknown;
  searchable: boolean;
}

export class ConfigSiteInspector {
  public inspect(site: TvBoxSite, sourceUrl?: string, index = 0): ConfigSiteInspection {
    const normalized = normalizeFongMiSite(site, sourceUrl, index);
    return {
      site,
      normalized,
      index,
      siteKey: normalized.key,
      siteName: normalized.name,
      type: normalized.type,
      api: normalized.api,
      ...(normalized.ext === undefined ? {} : { ext: normalized.ext }),
      searchable: normalized.searchable,
    };
  }
}
