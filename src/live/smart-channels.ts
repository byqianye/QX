import { createHash, randomUUID } from "node:crypto";

import {
  EpgRepository,
  LiveRepository,
  SmartChannelRepository,
} from "../data/repositories.js";
import type {
  EpgProgrammeRecord,
  EpgProgrammeUiState,
  EpgUiState,
} from "../epg/epg-types.js";
import { normalizeChannelName } from "./live-parser.js";
import type {
  LiveCatalogUiState,
  LiveChannelWithStreams,
  SmartChannelEpgUiState,
  SmartChannelMemberRecord,
  SmartChannelMemberUiState,
  SmartChannelRecord,
  SmartChannelSuggestionUiState,
  SmartChannelUiState,
  SmartPlaybackUiState,
} from "./live-types.js";

export class SmartChannelError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SmartChannelError";
    this.code = code;
  }
}

export interface SmartChannelCreateInput {
  name: string;
  logo?: string | null;
  group?: string | null;
  memberIds?: readonly string[];
}

export interface SmartChannelUpdateInput {
  name?: string;
  logo?: string | null;
  group?: string | null;
  sortOrder?: number;
}

export interface SmartChannelSelection {
  smartChannel: SmartChannelRecord;
  member: SmartChannelMemberRecord;
  liveChannel: LiveChannelWithStreams;
}

export interface SmartChannelServiceOptions {
  repository: SmartChannelRepository;
  liveRepository: LiveRepository;
  epgRepository: EpgRepository;
  now?: () => number;
}

interface SmartMemberView extends SmartChannelMemberUiState {
  liveChannel: LiveChannelWithStreams | null;
}

export class SmartChannelService {
  private readonly repository: SmartChannelRepository;
  private readonly liveRepository: LiveRepository;
  private readonly epgRepository: EpgRepository;
  private readonly now: () => number;
  private readonly healthScores = new Map<string, number>();
  private activeValue: { smartChannelId: string; memberId: string } | null = null;

  public constructor(options: SmartChannelServiceOptions) {
    this.repository = options.repository;
    this.liveRepository = options.liveRepository;
    this.epgRepository = options.epgRepository;
    this.now = options.now ?? Date.now;
  }

  public create(input: SmartChannelCreateInput): SmartChannelRecord {
    const name = requiredText(input.name, "SMART_CHANNEL_NAME_INVALID", "Smart Channel 名称不能为空。");
    const memberIds = uniqueStrings(input.memberIds ?? []);
    const liveChannels = this.liveRepository.getAllChannels();
    const byId = new Map(liveChannels.map((channel) => [channel.id, channel] as const));
    for (const memberId of memberIds) this.requireLiveChannel(byId, memberId);
    const now = this.now();
    const record: SmartChannelRecord = {
      id: `smart-${randomUUID()}`,
      name,
      logo: safeLogo(input.logo ?? null),
      group: optionalText(input.group),
      sortOrder: this.nextSortOrder(),
      preferredMemberId: null,
      epgSourceId: null,
      epgChannelId: null,
      createdAt: now,
      updatedAt: now,
    };
    const members = memberIds.map((liveChannelId, index) => ({
      id: `smart-member-${randomUUID()}`,
      smartChannelId: record.id,
      liveChannelId,
      priority: index,
      enabled: true,
    } satisfies SmartChannelMemberRecord));
    this.repository.create(record, members);
    return record;
  }

  public update(smartChannelId: string, input: SmartChannelUpdateInput): SmartChannelRecord {
    const current = this.requireSmartChannel(smartChannelId);
    const updated: SmartChannelRecord = {
      ...current,
      ...(input.name !== undefined ? { name: requiredText(input.name, "SMART_CHANNEL_NAME_INVALID", "Smart Channel 名称不能为空。") } : {}),
      ...(input.logo !== undefined ? { logo: safeLogo(input.logo) } : {}),
      ...(input.group !== undefined ? { group: optionalText(input.group) } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: boundedInteger(input.sortOrder, current.sortOrder) } : {}),
      updatedAt: this.now(),
    };
    this.repository.update(updated);
    return updated;
  }

  public delete(smartChannelId: string): void {
    this.requireSmartChannel(smartChannelId);
    this.repository.delete(smartChannelId);
    if (this.activeValue?.smartChannelId === smartChannelId) this.activeValue = null;
  }

  public addMember(smartChannelId: string, liveChannelId: string, priority?: number): SmartChannelMemberRecord {
    this.requireSmartChannel(smartChannelId);
    const liveChannel = this.liveRepository.getAllChannels().find((channel) => channel.id === liveChannelId);
    if (!liveChannel) throw new SmartChannelError("SMART_CHANNEL_LIVE_CHANNEL_NOT_FOUND", "直播频道不存在或已被移除。");
    const current = this.repository.listMembers(smartChannelId);
    if (current.some((member) => member.liveChannelId === liveChannelId)) {
      throw new SmartChannelError("SMART_CHANNEL_MEMBER_EXISTS", "该直播频道已经是 Smart Channel 成员。");
    }
    const member: SmartChannelMemberRecord = {
      id: `smart-member-${randomUUID()}`,
      smartChannelId,
      liveChannelId,
      priority: priority === undefined ? current.length : boundedInteger(priority, current.length),
      enabled: true,
    };
    this.repository.addMember(member);
    return member;
  }

  public removeMember(smartChannelId: string, memberId: string): void {
    this.requireMember(smartChannelId, memberId);
    this.repository.removeMember(smartChannelId, memberId);
    if (this.activeValue?.smartChannelId === smartChannelId && this.activeValue.memberId === memberId) {
      this.activeValue = null;
    }
  }

  public updateMember(
    smartChannelId: string,
    memberId: string,
    patch: { priority?: number; enabled?: boolean },
  ): SmartChannelMemberRecord {
    const current = this.requireMember(smartChannelId, memberId);
    const updated: SmartChannelMemberRecord = {
      ...current,
      ...(patch.priority !== undefined ? { priority: boundedInteger(patch.priority, current.priority) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    };
    this.repository.updateMember(updated);
    return updated;
  }

  public reorderMembers(smartChannelId: string, memberIds: readonly string[]): void {
    const members = this.repository.listMembers(smartChannelId);
    const unique = uniqueStrings(memberIds);
    if (unique.length !== members.length || unique.some((id) => !members.some((member) => member.id === id))) {
      throw new SmartChannelError("SMART_CHANNEL_MEMBER_ORDER_INVALID", "Smart Channel 成员顺序不完整。");
    }
    this.repository.reorderMembers(
      smartChannelId,
      unique.map((memberId, priority) => ({ memberId, priority })),
      this.now(),
    );
  }

  public setPreferredMember(smartChannelId: string, memberId: string | null): void {
    if (memberId !== null) this.requireMember(smartChannelId, memberId);
    this.repository.setPreferredMember(smartChannelId, memberId, this.now());
  }

  public setEpgMapping(smartChannelId: string, epgSourceId: string, epgChannelId: string): SmartChannelRecord {
    const current = this.requireSmartChannel(smartChannelId);
    const source = this.epgRepository.getSource(epgSourceId);
    if (!source) throw new SmartChannelError("SMART_CHANNEL_EPG_SOURCE_NOT_FOUND", "EPG 来源不存在。");
    const channel = this.epgRepository.getChannels(epgSourceId).find((candidate) => candidate.id === epgChannelId);
    if (!channel) throw new SmartChannelError("SMART_CHANNEL_EPG_CHANNEL_NOT_FOUND", "EPG 频道不存在。");
    const updated = { ...current, epgSourceId, epgChannelId, updatedAt: this.now() };
    this.repository.update(updated);
    return updated;
  }

  public clearEpgMapping(smartChannelId: string): SmartChannelRecord {
    const current = this.requireSmartChannel(smartChannelId);
    const updated = { ...current, epgSourceId: null, epgChannelId: null, updatedAt: this.now() };
    this.repository.update(updated);
    return updated;
  }

  public setHealthScore(liveChannelId: string, score: number | null): void {
    if (score === null) {
      this.healthScores.delete(liveChannelId);
      return;
    }
    if (!Number.isFinite(score)) throw new SmartChannelError("SMART_CHANNEL_HEALTH_INVALID", "频道健康分数无效。");
    this.healthScores.set(liveChannelId, Math.min(100, Math.max(0, score)));
  }

  public play(smartChannelId: string, memberId?: string): SmartChannelSelection {
    const selection = this.select(smartChannelId, memberId);
    this.activeValue = { smartChannelId, memberId: selection.member.id };
    return selection;
  }

  public select(smartChannelId: string, memberId?: string): SmartChannelSelection {
    const smartChannel = this.requireSmartChannel(smartChannelId);
    const liveChannels = this.liveRepository.getAllChannels();
    const byLiveId = new Map(liveChannels.map((channel) => [channel.id, channel] as const));
    const members = this.repository.listMembers(smartChannelId);
    const selected = memberId !== undefined
      ? this.requireAvailableMember(smartChannel, members, byLiveId, memberId)
      : this.pickLiveMember(smartChannel, members, byLiveId);
    if (!selected) {
      throw new SmartChannelError("SMART_CHANNEL_UNAVAILABLE", "频道来源不可用，请添加新来源或删除 Smart Channel。");
    }
    if (memberId !== undefined && smartChannel.preferredMemberId !== memberId) {
      this.repository.setPreferredMember(smartChannelId, memberId, this.now());
      smartChannel.preferredMemberId = memberId;
    }
    return { smartChannel, member: selected.member, liveChannel: selected.liveChannel };
  }

  public stop(): void {
    this.activeValue = null;
  }

  public uiState(catalog: LiveCatalogUiState, epg: EpgUiState): {
    smartChannels: readonly SmartChannelUiState[];
    smartSuggestions: readonly SmartChannelSuggestionUiState[];
    activeSmartChannel: SmartPlaybackUiState | null;
  } {
    const liveChannels = this.liveRepository.getAllChannels();
    const byLiveId = new Map(liveChannels.map((channel) => [channel.id, channel] as const));
    const sourceById = new Map(this.liveRepository.listSources().map((source) => [source.id, source] as const));
    const catalogById = new Map(catalog.channels.map((channel) => [channel.id, channel] as const));
    const smartChannels = this.repository.list().map((record) => {
      const members = this.repository.listMembers(record.id).map((member) => this.memberUi(
        member,
        byLiveId,
        sourceById,
        catalogById,
      ));
      const selected = this.pickUiMember(record, members);
      const epgState = this.epgState(record, members, epg, catalogById);
      return {
        id: record.id,
        name: record.name,
        logo: record.logo,
        group: record.group,
        sortOrder: record.sortOrder,
        preferredMemberId: record.preferredMemberId && members.some((member) => member.id === record.preferredMemberId)
          ? record.preferredMemberId
          : null,
        currentMemberId: selected?.id ?? null,
        currentSourceName: selected?.sourceName ?? null,
        available: selected !== null,
        members: members.map(({ liveChannel: _liveChannel, ...member }) => member),
        epg: epgState,
      } satisfies SmartChannelUiState;
    });
    return {
      smartChannels,
      smartSuggestions: this.buildSuggestions(liveChannels, catalog, epg),
      activeSmartChannel: this.activeUi(smartChannels),
    };
  }

  private activeUi(channels: readonly SmartChannelUiState[]): SmartPlaybackUiState | null {
    const active = this.activeValue;
    if (!active) return null;
    const smart = channels.find((channel) => channel.id === active.smartChannelId);
    const member = smart?.members.find((candidate) => candidate.id === active.memberId);
    if (!smart || !member) return null;
    return {
      smartChannelId: smart.id,
      smartChannelName: smart.name,
      memberId: member.id,
      liveChannelId: member.liveChannelId,
      sourceName: member.sourceName,
      channelName: member.channelName,
    };
  }

  private memberUi(
    member: SmartChannelMemberRecord,
    byLiveId: ReadonlyMap<string, LiveChannelWithStreams>,
    sourceById: ReadonlyMap<string, { name: string }>,
    catalogById: ReadonlyMap<string, LiveCatalogUiState["channels"][number]>,
  ): SmartMemberView {
    const liveChannel = byLiveId.get(member.liveChannelId) ?? null;
    const catalogChannel = catalogById.get(member.liveChannelId);
    const sourceName = liveChannel ? sourceById.get(liveChannel.sourceId)?.name ?? "来源已删除" : "来源已删除";
    const available = catalogChannel?.streams.some((stream) => stream.status === "ready") === true;
    return {
      ...member,
      channelName: liveChannel?.name ?? "频道来源不可用",
      sourceName,
      available,
      healthScore: this.healthScores.get(member.liveChannelId) ?? null,
      liveChannel,
    };
  }

  private pickUiMember(
    smartChannel: Pick<SmartChannelRecord, "preferredMemberId">,
    members: readonly SmartMemberView[],
  ): SmartMemberView | null {
    const candidates = members.filter((member) => member.enabled && member.available);
    const preferred = smartChannel.preferredMemberId
      ? candidates.find((member) => member.id === smartChannel.preferredMemberId)
      : undefined;
    return preferred ?? [...candidates].sort(compareMembers)[0] ?? null;
  }

  private pickLiveMember(
    smartChannel: Pick<SmartChannelRecord, "preferredMemberId">,
    members: readonly SmartChannelMemberRecord[],
    byLiveId: ReadonlyMap<string, LiveChannelWithStreams>,
  ): { member: SmartChannelMemberRecord; liveChannel: LiveChannelWithStreams } | null {
    const candidates = members
      .map((member) => ({ member, liveChannel: byLiveId.get(member.liveChannelId) ?? null }))
      .filter((value): value is { member: SmartChannelMemberRecord; liveChannel: LiveChannelWithStreams } => (
        value.liveChannel !== null
        && value.member.enabled
        && this.isLiveChannelAvailable(value.liveChannel)
      ));
    const preferred = smartChannel.preferredMemberId
      ? candidates.find((value) => value.member.id === smartChannel.preferredMemberId)
      : undefined;
    return preferred ?? [...candidates].sort((left, right) => this.compareLiveMembers(left.member, right.member))[0] ?? null;
  }

  private compareLiveMembers(left: SmartChannelMemberRecord, right: SmartChannelMemberRecord): number {
    const leftScore = this.healthScores.get(left.liveChannelId) ?? null;
    const rightScore = this.healthScores.get(right.liveChannelId) ?? null;
    if (leftScore !== null || rightScore !== null) {
      if (leftScore === null) return 1;
      if (rightScore === null) return -1;
      if (leftScore !== rightScore) return rightScore - leftScore;
    }
    return left.priority - right.priority || left.id.localeCompare(right.id);
  }

  private requireAvailableMember(
    smartChannel: SmartChannelRecord,
    members: readonly SmartChannelMemberRecord[],
    byLiveId: ReadonlyMap<string, LiveChannelWithStreams>,
    memberId: string,
  ): { member: SmartChannelMemberRecord; liveChannel: LiveChannelWithStreams } {
    const member = members.find((candidate) => candidate.id === memberId);
    const liveChannel = member ? byLiveId.get(member.liveChannelId) : undefined;
    if (!member || !liveChannel || !member.enabled || !this.isLiveChannelAvailable(liveChannel)) {
      throw new SmartChannelError("SMART_CHANNEL_MEMBER_UNAVAILABLE", `Smart Channel「${smartChannel.name}」的来源不可用。`);
    }
    return { member, liveChannel };
  }

  private isLiveChannelAvailable(channel: LiveChannelWithStreams): boolean {
    const source = this.liveRepository.getSource(channel.sourceId);
    return source?.enabled === true && channel.enabled && channel.streams.some((stream) => isSupportedStream(stream));
  }

  private buildSuggestions(
    liveChannels: readonly LiveChannelWithStreams[],
    catalog: LiveCatalogUiState,
    epg: EpgUiState,
  ): readonly SmartChannelSuggestionUiState[] {
    const visible = new Set(catalog.channels.map((channel) => channel.id));
    const candidates = liveChannels.filter((channel) => visible.has(channel.id));
    const suggestions = new Map<string, SmartChannelSuggestionUiState>();
    const addGroups = (
      groups: ReadonlyMap<string, readonly LiveChannelWithStreams[]>,
      reason: SmartChannelSuggestionUiState["reason"],
      confidence: SmartChannelSuggestionUiState["confidence"],
    ): void => {
      for (const group of groups.values()) {
        const memberIds = group.map((channel) => channel.id).sort();
        if (memberIds.length < 2 || new Set(group.map((channel) => channel.sourceId)).size < 2) continue;
        const id = `smart-suggestion-${sha256(`${reason}|${memberIds.join("|")}`).slice(0, 20)}`;
        if (suggestions.has(id)) continue;
        suggestions.set(id, {
          id,
          name: group[0]?.name ?? "Smart Channel",
          memberIds,
          reason,
          confidence,
        });
      }
    };
    addGroups(groupBy(candidates, (channel) => normalizedIdentifier(channel.tvgId)), "exact-tvg-id", "exact");
    addGroups(groupBy(candidates, (channel) => channel.normalizedName || normalizeChannelName(channel.name)), "exact-name", "high");
    const liveByMapping = new Map<string, LiveChannelWithStreams[]>();
    for (const mapping of epg.mappings) {
      if (!mapping.mapping || mapping.status !== "mapped") continue;
      const channel = candidates.find((candidate) => candidate.id === mapping.liveChannelId);
      if (!channel) continue;
      const key = `${mapping.mapping.epgSourceId}|${mapping.mapping.epgChannelId}`;
      const values = liveByMapping.get(key) ?? [];
      values.push(channel);
      liveByMapping.set(key, values);
    }
    addGroups(liveByMapping, "shared-epg", "high");
    return [...suggestions.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-Hans") || left.id.localeCompare(right.id));
  }

  private epgState(
    record: SmartChannelRecord,
    members: readonly SmartMemberView[],
    epg: EpgUiState,
    catalogById: ReadonlyMap<string, LiveCatalogUiState["channels"][number]>,
  ): SmartChannelEpgUiState {
    if (record.epgSourceId !== null || record.epgChannelId !== null) {
      if (!record.epgSourceId || !record.epgChannelId) return emptyEpgState("unavailable");
      const source = this.epgRepository.getSource(record.epgSourceId);
      const channel = this.epgRepository.getChannels(record.epgSourceId).find((candidate) => candidate.id === record.epgChannelId);
      if (!source || !channel) {
        return {
          ...emptyEpgState("unavailable"),
          sourceId: record.epgSourceId,
          channelId: record.epgChannelId,
        };
      }
      return {
        mode: "explicit",
        sourceId: source.id,
        channelId: channel.id,
        sourceName: source.name,
        channelName: channel.displayName,
        ...this.programmesFor(channel.id),
      };
    }
    if (!record.preferredMemberId) return emptyEpgState("unmapped");
    const preferred = members.find((member) => member.id === record.preferredMemberId);
    if (!preferred) return emptyEpgState("unmapped");
    const mapping = epg.mappings.find((candidate) => candidate.liveChannelId === preferred.liveChannelId);
    if (!mapping?.mapping) {
      return emptyEpgState(mapping?.status === "conflict" || mapping?.status === "ambiguous" ? "conflict" : "unmapped");
    }
    const liveChannel = catalogById.get(preferred.liveChannelId);
    return {
      mode: "inherited",
      sourceId: mapping.mapping.epgSourceId,
      channelId: mapping.mapping.epgChannelId,
      sourceName: mapping.mappingSourceName,
      channelName: mapping.mappingChannelName,
      currentProgramme: liveChannel?.currentProgramme ?? null,
      nextProgramme: liveChannel?.nextProgramme ?? null,
    };
  }

  private programmesFor(channelId: string): {
    currentProgramme: EpgProgrammeUiState | null;
    nextProgramme: EpgProgrammeUiState | null;
  } {
    const now = this.now();
    const current = this.epgRepository.currentProgramme(channelId, now);
    const next = this.epgRepository.nextProgramme(channelId, now);
    return {
      currentProgramme: current ? programmeUi(current, now) : null,
      nextProgramme: next ? programmeUi(next, now) : null,
    };
  }

  private requireSmartChannel(id: string): SmartChannelRecord {
    const smart = this.repository.get(id);
    if (!smart) throw new SmartChannelError("SMART_CHANNEL_NOT_FOUND", "Smart Channel 不存在。");
    return smart;
  }

  private requireMember(smartChannelId: string, memberId: string): SmartChannelMemberRecord {
    this.requireSmartChannel(smartChannelId);
    const member = this.repository.listMembers(smartChannelId).find((candidate) => candidate.id === memberId);
    if (!member) throw new SmartChannelError("SMART_CHANNEL_MEMBER_NOT_FOUND", "Smart Channel 成员不存在。");
    return member;
  }

  private requireLiveChannel(
    byId: ReadonlyMap<string, LiveChannelWithStreams>,
    liveChannelId: string,
  ): LiveChannelWithStreams {
    const channel = byId.get(liveChannelId);
    if (!channel) throw new SmartChannelError("SMART_CHANNEL_LIVE_CHANNEL_NOT_FOUND", "直播频道不存在或已被移除。");
    return channel;
  }

  private nextSortOrder(): number {
    return this.repository.list().reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1;
  }
}

function compareMembers(left: SmartChannelMemberUiState, right: SmartChannelMemberUiState): number {
  if (left.healthScore !== null || right.healthScore !== null) {
    if (left.healthScore === null) return 1;
    if (right.healthScore === null) return -1;
    if (left.healthScore !== right.healthScore) return right.healthScore - left.healthScore;
  }
  return left.priority - right.priority || left.id.localeCompare(right.id);
}

function groupBy(
  channels: readonly LiveChannelWithStreams[],
  keyFor: (channel: LiveChannelWithStreams) => string | null,
): ReadonlyMap<string, readonly LiveChannelWithStreams[]> {
  const groups = new Map<string, LiveChannelWithStreams[]>();
  for (const channel of channels) {
    const key = keyFor(channel);
    if (!key) continue;
    const values = groups.get(key) ?? [];
    values.push(channel);
    groups.set(key, values);
  }
  return groups;
}

function normalizedIdentifier(value: string | null): string | null {
  const normalized = value?.normalize("NFKC").trim().toLowerCase() ?? "";
  return normalized || null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function requiredText(value: string, code: string, message: string): string {
  const trimmed = value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 120);
  if (!trimmed) throw new SmartChannelError(code, message);
  return trimmed;
}

function optionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 120);
  return trimmed || null;
}

function boundedInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1_000_000, Math.floor(value))) : fallback;
}

function safeLogo(value: string | null): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isSupportedStream(stream: LiveChannelWithStreams["streams"][number]): boolean {
  if (!/^https?:\/\//iu.test(stream.url)) return false;
  const protocol = stream.protocol ?? (/\.m3u8(?:$|[?#])/iu.test(stream.url) ? "HLS" : "HTTP");
  return /^(?:HLS|HTTP|HTTPS|MP4|WEBM)$/iu.test(protocol);
}

function emptyEpgState(mode: SmartChannelEpgUiState["mode"]): SmartChannelEpgUiState {
  return {
    mode,
    sourceId: null,
    channelId: null,
    sourceName: null,
    channelName: null,
    currentProgramme: null,
    nextProgramme: null,
  };
}

function programmeUi(programme: EpgProgrammeRecord, now: number): EpgProgrammeUiState {
  const active = programme.startAt <= now && now < programme.endAt;
  return {
    id: programme.id,
    title: programme.title,
    subTitle: programme.subTitle,
    startAt: programme.startAt,
    endAt: programme.endAt,
    progress: active ? Math.min(1, Math.max(0, (now - programme.startAt) / (programme.endAt - programme.startAt))) : null,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
