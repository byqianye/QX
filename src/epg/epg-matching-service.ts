import { createHash } from "node:crypto";

import { EpgRepository } from "../data/repositories.js";
import { LiveRepository } from "../data/repositories.js";
import type {
  LiveCatalogUiState,
  LiveChannelRecord,
  LiveChannelUiState,
} from "../live/live-types.js";
import {
  bestEpgCandidates,
  matchEpgChannels,
  normalizeEpgAlias,
  type EpgMatchSource,
} from "./epg-matching.js";
import type {
  EpgChannelAliasRecord,
  EpgChannelMappingRecord,
  EpgMatchCandidate,
  EpgMappingStatus,
  EpgMatchConfidence,
  EpgProgrammeRecord,
  EpgProgrammeUiState,
  EpgTimelineUiState,
  EpgUiState,
  EpgMappingUiState,
} from "./epg-types.js";

const DEFAULT_TIMELINE_BEFORE_MS = 3 * 60 * 60 * 1000;
const DEFAULT_TIMELINE_AFTER_MS = 3 * 60 * 60 * 1000;
const MAX_TIMELINE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TIMELINE_ITEMS = 240;

export class EpgMappingError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EpgMappingError";
    this.code = code;
  }
}

export interface EpgMatchingServiceOptions {
  liveRepository: LiveRepository;
  epgRepository: EpgRepository;
  now?: () => number;
  timelineBeforeMs?: number;
  timelineAfterMs?: number;
}

interface TimelineRequest {
  liveChannelId: string;
  fromAt: number;
  toAt: number;
}

interface MappingBuild {
  state: EpgMappingUiState;
  selected: EpgChannelMappingRecord | null;
}

export class EpgMatchingService {
  private readonly liveRepository: LiveRepository;
  private readonly epgRepository: EpgRepository;
  private readonly now: () => number;
  private readonly timelineBeforeMs: number;
  private readonly timelineAfterMs: number;
  private timelineRequest: TimelineRequest | null = null;

  public constructor(options: EpgMatchingServiceOptions) {
    this.liveRepository = options.liveRepository;
    this.epgRepository = options.epgRepository;
    this.now = options.now ?? Date.now;
    this.timelineBeforeMs = positiveInteger(options.timelineBeforeMs, DEFAULT_TIMELINE_BEFORE_MS);
    this.timelineAfterMs = positiveInteger(options.timelineAfterMs, DEFAULT_TIMELINE_AFTER_MS);
  }

  public uiState(catalog: LiveCatalogUiState, epg: EpgUiState): {
    catalog: LiveCatalogUiState;
    epg: EpgUiState;
  } {
    const builds = this.buildMappings(catalog.channels);
    const byLiveChannel = new Map(builds.map((build) => [build.state.liveChannelId, build] as const));
    const enrichedChannels = catalog.channels.map((channel) => {
      const build = byLiveChannel.get(channel.id);
      const currentNext = build?.selected && build.state.status !== "conflict"
        ? this.currentNext(build.selected.epgChannelId)
        : { current: null, next: null };
      return {
        ...channel,
        epgStatus: build?.state.status ?? "unmapped",
        currentProgramme: currentNext.current ? toProgrammeUi(currentNext.current, this.now()) : null,
        nextProgramme: currentNext.next ? toProgrammeUi(currentNext.next, this.now()) : null,
      };
    });
    const timeline = this.timelineState(byLiveChannel);
    return {
      catalog: { ...catalog, channels: enrichedChannels },
      epg: {
        ...epg,
        mappings: builds.map((build) => build.state),
        timeline,
      },
    };
  }

  public setMapping(liveChannelId: string, epgSourceId: string, epgChannelId: string): EpgChannelMappingRecord {
    this.requireLiveChannel(liveChannelId);
    this.requireEpgChannel(epgSourceId, epgChannelId);
    const record = this.mappingRecord({
      id: mappingId(liveChannelId, epgSourceId),
      liveChannelId,
      epgSourceId,
      epgChannelId,
      method: "explicit",
      confidence: "exact",
      userConfirmed: true,
      updatedAt: this.now(),
    });
    this.epgRepository.upsertMapping(record);
    return record;
  }

  public confirmCandidate(liveChannelId: string, epgSourceId: string, epgChannelId: string): EpgChannelMappingRecord {
    this.requireLiveChannel(liveChannelId);
    this.requireEpgChannel(epgSourceId, epgChannelId);
    const candidate = this.candidatesForLiveChannel(liveChannelId).find((value) =>
      value.epgSourceId === epgSourceId && value.epgChannelId === epgChannelId,
    );
    if (!candidate) throw new EpgMappingError("EPG_MAPPING_CANDIDATE_INVALID", "EPG 匹配候选已失效，请重新计算建议。");
    const record = this.mappingRecord({
      id: mappingId(liveChannelId, epgSourceId),
      liveChannelId,
      epgSourceId,
      epgChannelId,
      method: candidate.method,
      confidence: candidate.confidence,
      userConfirmed: true,
      updatedAt: this.now(),
    });
    this.epgRepository.upsertMapping(record);
    return record;
  }

  public confirmHighConfidence(catalog: LiveCatalogUiState): number {
    let confirmed = 0;
    for (const build of this.buildMappings(catalog.channels)) {
      const candidate = build.state.candidates.length === 1 ? build.state.candidates[0] : undefined;
      if (!candidate || (candidate.confidence !== "exact" && candidate.confidence !== "high")) continue;
      if (build.state.mapping?.userConfirmed) continue;
      this.epgRepository.upsertMapping(this.mappingRecord({
        id: mappingId(build.state.liveChannelId, candidate.epgSourceId),
        liveChannelId: build.state.liveChannelId,
        epgSourceId: candidate.epgSourceId,
        epgChannelId: candidate.epgChannelId,
        method: candidate.method,
        confidence: candidate.confidence,
        userConfirmed: true,
        updatedAt: this.now(),
      }));
      confirmed += 1;
    }
    return confirmed;
  }

  public clearMapping(liveChannelId: string, epgSourceId?: string): void {
    this.requireLiveChannel(liveChannelId);
    this.epgRepository.deleteMapping(liveChannelId, epgSourceId);
  }

  public setAlias(liveChannelId: string, alias: string): EpgChannelAliasRecord {
    this.requireLiveChannel(liveChannelId);
    const trimmed = alias.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 120);
    const normalizedAlias = normalizeEpgAlias(trimmed);
    if (!normalizedAlias) throw new EpgMappingError("EPG_MAPPING_ALIAS_INVALID", "EPG alias 不能为空。");
    const record: EpgChannelAliasRecord = {
      id: `epg-alias-${sha256(`${liveChannelId}|${normalizedAlias}`).slice(0, 24)}`,
      liveChannelId,
      alias: trimmed,
      normalizedAlias,
      updatedAt: this.now(),
    };
    this.epgRepository.upsertAlias(record);
    return record;
  }

  public removeAlias(liveChannelId: string, alias: string): void {
    this.requireLiveChannel(liveChannelId);
    const normalizedAlias = normalizeEpgAlias(alias);
    if (!normalizedAlias) return;
    this.epgRepository.deleteAlias(liveChannelId, normalizedAlias);
  }

  public setTimeline(liveChannelId: string, fromAt?: number, toAt?: number): void {
    this.requireLiveChannel(liveChannelId);
    const now = this.now();
    const requestedFrom = finiteNumber(fromAt, now - this.timelineBeforeMs);
    const requestedTo = finiteNumber(toAt, now + this.timelineAfterMs);
    const from = Math.min(requestedFrom, requestedTo);
    const to = Math.max(requestedFrom, requestedTo);
    const boundedTo = Math.min(to, from + MAX_TIMELINE_WINDOW_MS);
    this.timelineRequest = { liveChannelId, fromAt: from, toAt: Math.max(from + 1, boundedTo) };
  }

  public clearTimeline(): void {
    this.timelineRequest = null;
  }

  public close(): void {
    this.clearTimeline();
  }

  private buildMappings(channels: readonly LiveChannelUiState[]): readonly MappingBuild[] {
    const liveRecords = new Map(this.liveRepository.getAllChannels().map((channel) => [channel.id, channel] as const));
    const allSources = this.epgRepository.listSources();
    const sourceById = new Map(allSources.map((source) => [source.id, source] as const));
    const enabledSources = allSources.filter((source) => source.enabled).map((source) => ({
      id: source.id,
      name: source.name,
      channels: this.epgRepository.getChannels(source.id),
    } satisfies EpgMatchSource));
    const persisted = this.epgRepository.listMappings();
    const aliases = this.epgRepository.listAliases();
    const aliasesByLive = new Map<string, string[]>();
    for (const alias of aliases) {
      const values = aliasesByLive.get(alias.liveChannelId) ?? [];
      values.push(alias.alias);
      aliasesByLive.set(alias.liveChannelId, values);
    }
    return channels.map((channel) => {
      const channelAliases = aliasesByLive.get(channel.id) ?? [];
      const liveRecord = liveRecords.get(channel.id);
      const saved = persisted.filter((mapping) => mapping.liveChannelId === channel.id);
      const confirmed = saved.filter((mapping) => mapping.userConfirmed);
      const candidates = liveRecord
        ? bestEpgCandidates(enabledSources.flatMap((source) => matchEpgChannels(liveRecord, source, channelAliases)))
        : [];
      if (confirmed.length > 1) {
        return {
          state: this.uiMapping(channel, "conflict", null, candidates, channelAliases, sourceById),
          selected: null,
        };
      }
      if (confirmed.length === 1) {
        const mapping = confirmed[0]!;
        return {
          state: this.uiMapping(channel, "mapped", mapping, candidates, channelAliases, sourceById),
          selected: mapping,
        };
      }
      const storedDefaultable = saved.filter((mapping) =>
        !mapping.userConfirmed && isDefaultable(mapping.confidence),
      );
      if (storedDefaultable.length > 1) {
        return {
          state: this.uiMapping(channel, "conflict", null, candidates, channelAliases, sourceById),
          selected: null,
        };
      }
      if (storedDefaultable.length === 1) {
        const mapping = storedDefaultable[0]!;
        return {
          state: this.uiMapping(channel, "mapped", mapping, candidates, channelAliases, sourceById),
          selected: mapping,
        };
      }
      if (candidates.length === 1 && isDefaultable(candidates[0]!.confidence)) {
        const mapping = mappingFromCandidate(channel.id, candidates[0]!);
        return {
          state: this.uiMapping(channel, "mapped", mapping, candidates, channelAliases, sourceById),
          selected: mapping,
        };
      }
      const status: EpgMappingStatus = candidates.length > 1
        ? "ambiguous"
        : candidates.length > 0 ? "suggested" : "unmapped";
      return {
        state: this.uiMapping(channel, status, null, candidates, channelAliases, sourceById),
        selected: null,
      };
    });
  }

  private uiMapping(
    channel: LiveChannelUiState,
    status: EpgMappingStatus,
    mapping: EpgChannelMappingRecord | null,
    candidates: readonly EpgMatchCandidate[],
    aliases: readonly string[],
    sourceById: ReadonlyMap<string, { name: string }>,
  ): EpgMappingUiState {
    const mappingSourceName = mapping ? sourceById.get(mapping.epgSourceId)?.name ?? null : null;
    const mappingChannelName = mapping
      ? this.epgRepository.getChannels(mapping.epgSourceId).find((value) => value.id === mapping.epgChannelId)?.displayName ?? null
      : null;
    return {
      liveChannelId: channel.id,
      liveChannelName: channel.name,
      liveSourceName: channel.sourceName,
      status,
      mapping,
      mappingSourceName,
      mappingChannelName,
      aliases: [...aliases],
      candidates,
    };
  }

  private timelineState(byLiveChannel: ReadonlyMap<string, MappingBuild>): EpgTimelineUiState | null {
    const request = this.timelineRequest;
    if (!request) return null;
    const mapping = byLiveChannel.get(request.liveChannelId)?.selected;
    const items = mapping
      ? this.epgRepository.listProgrammes(mapping.epgChannelId, request.fromAt, request.toAt)
        .slice(0, MAX_TIMELINE_ITEMS)
        .map((programme) => toProgrammeUi(programme, this.now()))
      : [];
    return { ...request, items };
  }

  private currentNext(epgChannelId: string): { current: EpgProgrammeRecord | null; next: EpgProgrammeRecord | null } {
    const current = this.epgRepository.currentProgramme(epgChannelId, this.now());
    const next = this.epgRepository.nextProgramme(epgChannelId, this.now());
    return { current, next };
  }

  private candidatesForLiveChannel(liveChannelId: string): readonly EpgMatchCandidate[] {
    const channel = this.requireLiveChannel(liveChannelId);
    const aliases = this.epgRepository.listAliases(liveChannelId).map((alias) => alias.alias);
    const sources = this.epgRepository.listSources()
      .filter((source) => source.enabled)
      .map((source) => ({
        id: source.id,
        name: source.name,
        channels: this.epgRepository.getChannels(source.id),
      } satisfies EpgMatchSource));
    return bestEpgCandidates(sources.flatMap((source) => matchEpgChannels(channel, source, aliases)));
  }

  private requireLiveChannel(liveChannelId: string): LiveChannelRecord {
    const channel = this.liveRepository.getAllChannels().find((value) => value.id === liveChannelId);
    if (!channel) throw new EpgMappingError("EPG_MAPPING_LIVE_CHANNEL_NOT_FOUND", "直播频道不存在。");
    return channel;
  }

  private requireEpgChannel(epgSourceId: string, epgChannelId: string): void {
    const source = this.epgRepository.getSource(epgSourceId);
    if (!source) throw new EpgMappingError("EPG_MAPPING_SOURCE_NOT_FOUND", "EPG 来源不存在。");
    const channel = this.epgRepository.getChannels(epgSourceId).find((value) => value.id === epgChannelId);
    if (!channel) throw new EpgMappingError("EPG_MAPPING_CHANNEL_NOT_FOUND", "EPG 频道不存在。");
  }

  private mappingRecord(record: EpgChannelMappingRecord): EpgChannelMappingRecord {
    return { ...record };
  }
}

function mappingFromCandidate(liveChannelId: string, candidate: EpgMatchCandidate): EpgChannelMappingRecord {
  return {
    id: `auto-${mappingId(liveChannelId, candidate.epgSourceId)}`,
    liveChannelId,
    epgSourceId: candidate.epgSourceId,
    epgChannelId: candidate.epgChannelId,
    method: candidate.method,
    confidence: candidate.confidence,
    userConfirmed: false,
    updatedAt: 0,
  };
}

function mappingId(liveChannelId: string, epgSourceId: string): string {
  return `epg-mapping-${sha256(`${liveChannelId}|${epgSourceId}`).slice(0, 24)}`;
}

function toProgrammeUi(programme: EpgProgrammeRecord, now: number): EpgProgrammeUiState {
  const active = programme.startAt <= now && now < programme.endAt;
  return {
    id: programme.id,
    title: programme.title,
    subTitle: programme.subTitle,
    startAt: programme.startAt,
    endAt: programme.endAt,
    progress: active ? clamp((now - programme.startAt) / (programme.endAt - programme.startAt), 0, 1) : null,
  };
}

function isDefaultable(confidence: EpgMatchConfidence): boolean {
  return confidence === "exact" || confidence === "high";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
