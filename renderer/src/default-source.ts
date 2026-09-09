import { DEFAULT_SOURCE_CATALOG } from "./default-source-catalog.js";

/** Fixed after live home, image and detail measurements; no startup ranking. */
export const DEFAULT_SOURCE_URL = "http://xn--z7x900a.net/";
export const DEFAULT_SOURCE_SITE_KEY = "光盘";

/**
 * Metadata-only bootstrap for first launch and failed manual refreshes.
 * Preserve the complete catalog, including its parser rules and site options.
 */
export const DEFAULT_SOURCE_FALLBACK_CONFIG = JSON.stringify(DEFAULT_SOURCE_CATALOG);

export function shouldLoadDefaultSource(input: {
  desktop: boolean;
  ready: boolean;
  status: string;
  savedSource?: string | null;
  persistenceError: boolean;
  requested: boolean;
  playerWindow: boolean;
}): boolean {
  return input.desktop && input.ready && input.status === "empty"
    && !input.savedSource && !input.persistenceError && !input.requested && !input.playerWindow;
}
