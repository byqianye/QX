import type { TvBoxConfig, TvBoxSite } from "../config/decoder.js";
import type { SourceCapabilities, SourceEngine } from "../source/media-source.js";
import { JELLYFIN_CAPABILITIES } from "../jellyfin/jellyfin-source.js";
import { validateJellyfinConfig, type JellyfinConfig } from "../jellyfin/jellyfin-adapter.js";
import {
  resolveJvmSpiderDefinition,
  type JvmSpiderDefinition,
} from "../spider/jvm-spiders.js";
import { routeSpiderApi } from "../spider/rpc.js";

export interface DesktopSourceBinding {
  engine: Exclude<SourceEngine, "fixture">;
  api: string;
  capabilities: SourceCapabilities;
  definition?: JvmSpiderDefinition;
  script?: string;
  jellyfinConfig?: JellyfinConfig;
}

export function resolveDesktopSourceBinding(
  config: TvBoxConfig,
  site: TvBoxSite,
): DesktopSourceBinding | undefined {
  if (typeof site.api !== "string") return undefined;
  const api = site.api;
  const engine = routeSpiderApi(api);
  if (engine === "java") {
    const definition = resolveJvmSpiderDefinition(api, site);
    if (!definition) return undefined;
    return {
      engine: "jvm",
      api,
      capabilities: definition.capabilities,
      definition,
    };
  }
  if (engine === "quickjs") {
    const script = quickJsScriptReference(config, site);
    if (!script) return undefined;
    return {
      engine: "quickjs",
      api,
      capabilities: emptyCapabilities("quickjs"),
      script,
    };
  }
  if (engine === "python") {
    const script = pythonScriptReference(config, site);
    if (!script) return undefined;
    return {
      engine: "python",
      api,
      capabilities: emptyCapabilities("python"),
      script,
    };
  }
  if (/^jellyfin$/i.test(api) || /^jellyfin:/i.test(api)) {
    const jellyfinConfig = jellyfinConfigReference(config, site);
    return {
      engine: "jellyfin",
      api,
      capabilities: { ...JELLYFIN_CAPABILITIES },
      ...(jellyfinConfig ? { jellyfinConfig } : {}),
    };
  }
  return undefined;
}

export function quickJsScriptReference(config: TvBoxConfig, site: TvBoxSite): string | undefined {
  const api = typeof site.api === "string" ? site.api.trim() : "";
  if (/^js:/i.test(api)) {
    const value = api.slice(3).trim();
    if (value) return value;
  }
  if (looksLikeJavaScriptReference(api)) return api;
  for (const value of [site.script, site.spider, config.spider]) {
    if (typeof value === "string" && looksLikeJavaScriptReference(value)) return stripEnginePrefix(value);
  }
  return undefined;
}

export function pythonScriptReference(config: TvBoxConfig, site: TvBoxSite): string | undefined {
  const api = typeof site.api === "string" ? site.api.trim() : "";
  if (/^py:/i.test(api)) {
    const value = api.slice(3).trim();
    if (value) return value;
  }
  if (looksLikePythonReference(api)) return api;
  for (const value of [site.script, site.spider, config.spider]) {
    if (typeof value === "string" && looksLikePythonReference(value)) return stripEnginePrefix(value);
  }
  return undefined;
}

export function emptyCapabilities(engine: Exclude<SourceEngine, "fixture" | "jvm"> | "jvm"): SourceCapabilities {
  return {
    home: false,
    category: false,
    search: false,
    detail: false,
    playback: false,
    localProxy: false,
    filters: false,
    pagination: false,
    engine,
  };
}

function looksLikeJavaScriptReference(value: string): boolean {
  return /^https?:\/\//i.test(value) && /\.m?js(?:[?#].*)?$/i.test(value)
    || /^file:\/\//i.test(value) && /\.m?js(?:[?#].*)?$/i.test(value)
    || /(^|[\\/])[^?]*\.m?js(?:[?#].*)?$/i.test(value);
}

function looksLikePythonReference(value: string): boolean {
  return /^https?:\/\//i.test(value) && /\.py(?:[?#].*)?$/i.test(value)
    || /^file:\/\//i.test(value) && /\.py(?:[?#].*)?$/i.test(value)
    || /(^|[\\/])[^?]*\.py(?:[?#].*)?$/i.test(value);
}

function stripEnginePrefix(value: string): string {
  return /^js:/i.test(value) ? value.slice(3).trim() : value;
}

function jellyfinConfigReference(config: TvBoxConfig, site: TvBoxSite): JellyfinConfig | undefined {
  const candidates = [
    site.jellyfinConfig,
    site.jellyfin,
    config.jellyfinConfig,
    config.jellyfin,
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const baseUrl = candidate.baseUrl ?? candidate.url;
    const token = candidate.token;
    const userId = candidate.userId ?? candidate.user_id;
    if (typeof baseUrl !== "string" || typeof token !== "string" || typeof userId !== "string") continue;
    return validateJellyfinConfig({ baseUrl, token, userId });
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
