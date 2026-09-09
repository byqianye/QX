export const DEFAULT_TEST_PRESET_URL = "http://xn--z7x900a.net/";

const TRAILING_CONFIG_PUNCTUATION = /[\s,，。；;：:、!！?？]+$/u;

export function normalizeConfigInput(value: string): string {
  let normalized = value.trim();
  while (TRAILING_CONFIG_PUNCTUATION.test(normalized)) {
    normalized = normalized.replace(TRAILING_CONFIG_PUNCTUATION, "").trim();
  }
  return normalized;
}

export function configuredTestPresetUrl(env: Record<string, unknown> = import.meta.env): string {
  return typeof env.VITE_QX_TEST_PRESET_URL === "string"
    ? normalizeConfigInput(env.VITE_QX_TEST_PRESET_URL)
    : "";
}

export function testPresetAutoLoadEnabled(env: Record<string, unknown> = import.meta.env): boolean {
  return env.VITE_QX_TEST_PRESET_AUTO_LOAD === "1" && configuredTestPresetUrl(env).length > 0;
}

export function testPresetAutoConfirmEnabled(env: Record<string, unknown> = import.meta.env): boolean {
  return testPresetAutoLoadEnabled(env) && env.VITE_QX_TEST_PRESET_AUTO_CONFIRM === "1";
}
