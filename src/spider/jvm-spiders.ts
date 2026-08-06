import type { SourceCapabilities } from "../source/media-source.js";
import type { TvBoxSite } from "../config/decoder.js";

export interface JvmSpiderDefinition {
  api: string;
  className: string;
  playback: "none" | "player";
  capabilities: SourceCapabilities;
}

const definitions: readonly JvmSpiderDefinition[] = [
  {
    api: "csp_Douban",
    className: "com.qx.spike.fixture.DoubanJvmSpider",
    playback: "none",
    capabilities: capabilities("jvm", false),
  },
  {
    api: "csp_PlayableFixture",
    className: "com.qx.spike.fixture.PlayableJvmSpider",
    playback: "player",
    capabilities: capabilities("fixture", true),
  },
];

export function findJvmSpider(api: string | undefined): JvmSpiderDefinition | undefined {
  if (!api) return undefined;
  return definitions.find((definition) => definition.api.toLowerCase() === api.toLowerCase());
}

/**
 * Resolve a JVM Spider only when the configuration supplies an explicit class
 * binding for an API that the router already identifies as JVM-native. This
 * keeps the supported surface honest instead of treating every csp_* name as
 * an automatically compatible CatVod implementation.
 */
export function resolveJvmSpiderDefinition(
  api: string | undefined,
  site?: TvBoxSite,
): JvmSpiderDefinition | undefined {
  const known = findJvmSpider(api);
  if (known) return known;
  if (!api || !/^csp_/i.test(api)) return undefined;

  const className = explicitJvmSpiderClass(site);
  if (!className) return undefined;
  return {
    api,
    className,
    playback: "none",
    capabilities: capabilities("jvm", false),
  };
}

export function explicitJvmSpiderClass(site: TvBoxSite | undefined): string | undefined {
  if (!site) return undefined;
  for (const key of ["spiderClass", "className", "class"]) {
    const value = site[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function supportedJvmSpiders(): readonly JvmSpiderDefinition[] {
  return definitions;
}

export function sourceCapabilitiesForApi(api: string | undefined): SourceCapabilities {
  const definition = findJvmSpider(api);
  return definition?.capabilities ?? capabilities("jvm", false);
}

function capabilities(engine: "jvm" | "fixture", playback: boolean): SourceCapabilities {
  return {
    home: true,
    category: true,
    search: true,
    detail: true,
    playback,
    localProxy: false,
    filters: true,
    pagination: true,
    engine,
  };
}
