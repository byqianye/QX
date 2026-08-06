export interface JvmSpiderDefinition {
  api: "csp_Douban" | "csp_PlayableFixture";
  className: string;
  playback: "none" | "player";
}

const definitions: readonly JvmSpiderDefinition[] = [
  {
    api: "csp_Douban",
    className: "com.qx.spike.fixture.DoubanJvmSpider",
    playback: "none",
  },
  {
    api: "csp_PlayableFixture",
    className: "com.qx.spike.fixture.PlayableJvmSpider",
    playback: "player",
  },
];

export function findJvmSpider(api: string | undefined): JvmSpiderDefinition | undefined {
  if (!api) return undefined;
  return definitions.find((definition) => definition.api.toLowerCase() === api.toLowerCase());
}

export function supportedJvmSpiders(): readonly JvmSpiderDefinition[] {
  return definitions;
}
