import { normalizeChannelName } from "../live/live-parser.js";
import type { LiveChannelRecord } from "../live/live-types.js";
import type {
  EpgChannelRecord,
  EpgMatchCandidate,
  EpgMatchConfidence,
  EpgMappingMethod,
} from "./epg-types.js";

export interface EpgMatchSource {
  id: string;
  name: string;
  channels: readonly EpgChannelRecord[];
}

const MATCH_METHOD_ORDER: Record<Exclude<EpgMappingMethod, "explicit">, number> = {
  "tvg-id": 0,
  "normalized-name": 1,
  alias: 2,
};

export function normalizeEpgIdentifier(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").trim();
}

export function normalizeEpgAlias(value: string): string {
  return normalizeChannelName(value);
}

export function matchEpgChannels(
  liveChannel: Pick<LiveChannelRecord, "name" | "normalizedName" | "tvgId" | "tvgName">,
  source: EpgMatchSource,
  aliases: readonly string[] = [],
): readonly EpgMatchCandidate[] {
  const tvgId = normalizeEpgIdentifier(liveChannel.tvgId);
  if (tvgId) {
    const exactId = source.channels.filter((channel) => normalizeEpgIdentifier(channel.externalId) === tvgId);
    if (exactId.length > 0) return candidates(source, exactId, "tvg-id", "exact", 1);
  }

  const liveName = liveChannel.normalizedName || normalizeChannelName(liveChannel.name);
  if (liveName) {
    const exactName = source.channels.filter((channel) => channel.normalizedName === liveName);
    if (exactName.length > 0) return candidates(source, exactName, "normalized-name", "high", 0.95);
  }

  const aliasNames = new Set([
    ...aliases.map(normalizeEpgAlias),
    ...(liveChannel.tvgName ? [normalizeEpgAlias(liveChannel.tvgName)] : []),
  ].filter((value) => value.length > 0));
  if (aliasNames.size === 0) return [];
  const aliasMatches = source.channels.filter((channel) => {
    const names = [channel.normalizedName, ...channel.displayNames.map(normalizeEpgAlias)];
    return names.some((name) => aliasNames.has(name));
  });
  return candidates(source, aliasMatches, "alias", "medium", 0.75);
}

export function bestEpgCandidates(candidates: readonly EpgMatchCandidate[]): readonly EpgMatchCandidate[] {
  const bestMethod = candidates.reduce<number | null>((best, candidate) => {
    const rank = MATCH_METHOD_ORDER[candidate.method];
    return best === null ? rank : Math.min(best, rank);
  }, null);
  if (bestMethod === null) return [];
  return [...candidates]
    .filter((candidate) => MATCH_METHOD_ORDER[candidate.method] === bestMethod)
    .sort((left, right) => left.epgSourceId.localeCompare(right.epgSourceId) || left.epgChannelId.localeCompare(right.epgChannelId));
}

function candidates(
  source: EpgMatchSource,
  channels: readonly EpgChannelRecord[],
  method: Exclude<EpgMappingMethod, "explicit">,
  confidence: Exclude<EpgMatchConfidence, "none">,
  score: number,
): readonly EpgMatchCandidate[] {
  return channels.map((channel) => ({
    epgSourceId: source.id,
    epgSourceName: source.name,
    epgChannelId: channel.id,
    epgChannelName: channel.displayName,
    method,
    confidence,
    score,
  }));
}
