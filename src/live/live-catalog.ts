import { LiveRepository } from "../data/repositories.js";
import type {
  LiveCatalogUiState,
  LiveChannelGroupUiState,
  LiveChannelUiState,
  LiveRecentUiState,
  LiveChannelWithStreams,
  LiveSourceRecord,
} from "./live-types.js";

export function buildLiveCatalog(repository: LiveRepository): LiveCatalogUiState {
  const sources = new Map(repository.listSources().map((source) => [source.id, source] as const));
  const channels = repository.getAllChannels()
    .filter((channel) => sources.get(channel.sourceId)?.enabled === true && channel.enabled)
    .map((channel) => toChannelUi(channel, sources.get(channel.sourceId)));
  const groups = buildGroups(channels);
  const channelById = new Map(channels.map((channel) => [channel.id, channel] as const));
  const recent: LiveRecentUiState[] = [];
  for (const item of repository.listRecent()) {
    const channel = channelById.get(item.channelId);
    const source = sources.get(item.sourceId);
    if (!channel || !source) continue;
    recent.push({
      ...item,
      channelName: channel.name,
      sourceName: source.name,
    });
  }
  return { groups, channels, recent };
}

function toChannelUi(
  channel: LiveChannelWithStreams,
  source: LiveSourceRecord | undefined,
): LiveChannelUiState {
  const streams = channel.streams.map((stream, index) => {
    const protocol = stream.protocol ?? inferProtocol(stream.url);
    return {
      id: stream.id,
      label: stream.label ?? `线路 ${index + 1}`,
      protocol,
      status: isSupportedProtocol(protocol, stream.url) ? "ready" : "unsupported",
    } as const;
  });
  return {
    id: channel.id,
    sourceId: channel.sourceId,
    sourceName: source?.name ?? "未知来源",
    name: channel.name,
    group: channel.group,
    logo: safeLogo(channel.logo),
    channelNumber: channel.tvgChno,
    streamCount: streams.length,
    streams,
    currentProgramme: null,
    health: null,
  };
}

function buildGroups(channels: readonly LiveChannelUiState[]): readonly LiveChannelGroupUiState[] {
  const counts = new Map<string, number>();
  for (const channel of channels) {
    const id = channel.group?.trim() || "__ungrouped__";
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [
    { id: "__all__", name: "全部频道", channelCount: channels.length },
    ...[...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "zh-Hans"))
      .map(([id, channelCount]) => ({
        id,
        name: id === "__ungrouped__" ? "未分组" : id,
        channelCount,
      })),
  ];
}

function inferProtocol(url: string): string {
  if (/\.m3u8(?:$|[?#])/iu.test(url)) return "HLS";
  return "HTTP";
}

function isSupportedProtocol(protocol: string, url: string): boolean {
  if (!/^https?:\/\//iu.test(url)) return false;
  return /^(?:HLS|HTTP|HTTPS|MP4|WEBM)$/iu.test(protocol);
}

function safeLogo(value: string | null): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
