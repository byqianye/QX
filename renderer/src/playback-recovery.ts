import type { PlaybackCatalog, PlaybackSelection } from "./state.js";

function normalized(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}]/gu, "");
}

export function episodeNumber(name: string): number | null {
  const match = name.normalize("NFKC").trim().match(/^(?:第\s*(\d+)\s*[集话話]|(?:ep(?:isode)?\s*)?(\d+))(?:\s*[-:：].*)?$/iu);
  const value = Number(match?.[1] ?? match?.[2]);
  return match && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Strict identity check for unattended recovery; fuzzy matches remain manual. */
export function sameRecoveryContent(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const title = normalized(left.vod_name ?? left.title);
  if (!title || title !== normalized(right.vod_name ?? right.title)) return false;
  const year = String(left.vod_year ?? left.year ?? "").match(/^(?:19|20)\d{2}$/u)?.[0];
  if (!year || year !== String(right.vod_year ?? right.year ?? "")) return false;
  const season = (value: Record<string, unknown>): string => normalized(value.vod_season ?? value.season
    ?? String(value.vod_name ?? value.title ?? "").match(/第[一二三四五六七八九十\d]+季|season\s*\d+|\bs\d+\b/iu)?.[0]);
  return season(left) === season(right);
}

export function recoverySelection(current: PlaybackCatalog, selected: PlaybackSelection, target: PlaybackCatalog,
  currentVod?: Record<string, unknown>, targetVod?: Record<string, unknown>): PlaybackSelection | null {
  if (currentVod && targetVod && !sameRecoveryContent(currentVod, targetVod)) return null;
  const episode = current.lines.find(line => line.index === selected.lineIndex)?.episodes[selected.episodeIndex];
  if (!episode) return null;
  const number = episodeNumber(episode.name);
  for (const line of target.lines) {
    const matches = line.episodes.filter(candidate => number !== null
      ? episodeNumber(candidate.name) === number : normalized(candidate.name) === normalized(episode.name));
    if (matches.length === 1) return { lineIndex: line.index, episodeIndex: matches[0]!.index };
    if (matches.length > 1) return null;
  }
  // Explicit movie metadata permits differing labels such as 正片 / HD中字.
  if (currentVod && targetVod && /电影|movie/iu.test(String(currentVod.type_name ?? currentVod.type ?? ""))
    && current.lines.every(line => line.episodes.length === 1)
    && target.lines.every(line => line.episodes.length === 1)) {
    const line = target.lines[0];
    if (line?.episodes[0]) return { lineIndex: line.index, episodeIndex: line.episodes[0].index };
  }
  return null;
}

export class PlaybackProgressWatchdog {
  private lastProgressAt: number;
  private startedAt: number;
  private position = 0;
  private decoded = false;
  private suspended = false;
  private fired = false;
  constructor(now: number) { this.startedAt = now; this.lastProgressAt = now; }
  progress(now: number, position: number, decoded = false): void {
    this.decoded ||= decoded;
    if (Math.abs(position - this.position) > 0.025 || decoded) this.lastProgressAt = now;
    this.position = position;
  }
  check(now: number, playingIntent: boolean, seeking: boolean): "startup-timeout" | "stalled" | null {
    if (!playingIntent || seeking) { this.suspended = true; return null; }
    if (this.suspended) { this.suspended = false; this.startedAt = now; this.lastProgressAt = now; }
    if (this.fired) return null;
    if (!this.decoded && now - this.startedAt >= 15_000) { this.fired = true; return "startup-timeout"; }
    if (this.decoded && now - this.lastProgressAt >= 8_000) { this.fired = true; return "stalled"; }
    return null;
  }
}
/** Transport-safe identity: Chinese source names must survive the Rust RPC sanitizer. */
export function recoveryCandidateId(source: string, vodId: string): string {
  const value = `${source}:${vodId}`;
  if (/^[a-z0-9_.:-]{1,120}$/iu.test(value)) return value;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `source:${hash.toString(16)}`;
}
