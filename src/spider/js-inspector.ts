import type { TvBoxConfig, TvBoxSite } from "../config/decoder.js";

export interface JsInspection {
  isJavaScript: boolean;
  reference?: string;
}

export class JsInspector {
  public inspect(site: TvBoxSite, config?: TvBoxConfig): JsInspection {
    const reference = references(site, config).find((value) => (
      /^js:/i.test(value) || /\.m?js(?:$|[?#])/i.test(value)
    ));
    return reference ? { isJavaScript: true, reference } : { isJavaScript: false };
  }
}

function references(site: TvBoxSite, config?: TvBoxConfig): string[] {
  return [site.api, site.ext, site.script, site.spider, config?.spider]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}
