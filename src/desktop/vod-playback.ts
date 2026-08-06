export interface PlaybackEpisode {
  index: number;
  name: string;
  id: string;
}

export interface PlaybackLine {
  index: number;
  name: string;
  episodes: readonly PlaybackEpisode[];
}

export interface PlaybackCatalog {
  lines: readonly PlaybackLine[];
}

export interface PlaybackSelection {
  lineIndex: number;
  episodeIndex: number;
}

export class PlaybackFormatError extends Error {
  public readonly code = "PLAYBACK_FORMAT_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "PlaybackFormatError";
  }
}

export function parseVodPlayback(detail: Record<string, unknown>): PlaybackCatalog | null {
  const hasFrom = Object.prototype.hasOwnProperty.call(detail, "vod_play_from");
  const hasUrl = Object.prototype.hasOwnProperty.call(detail, "vod_play_url");
  if (!hasFrom && !hasUrl) return null;

  const lineNames = readPlaybackField(detail.vod_play_from, "vod_play_from", hasFrom);
  const lineValues = readPlaybackField(detail.vod_play_url, "vod_play_url", hasUrl);
  if (lineNames === null || lineValues === null) {
    throw new PlaybackFormatError("vod_play_from and vod_play_url must be strings.");
  }
  if (lineNames.length === 0 && lineValues.length === 0) return { lines: [] };

  const lineCount = Math.max(lineNames.length, lineValues.length);
  const lines: PlaybackLine[] = [];
  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const rawName = lineNames[lineIndex] ?? "";
    const rawEpisodes = lineValues[lineIndex] ?? "";
    const episodes = parseEpisodes(rawEpisodes, lineIndex);
    lines.push({
      index: lineIndex,
      name: rawName || `线路 ${lineIndex + 1}`,
      episodes,
    });
  }
  return { lines };
}

function readPlaybackField(
  value: unknown,
  fieldName: string,
  present: boolean,
): string[] | null {
  if (!present) return [];
  if (typeof value !== "string") {
    throw new PlaybackFormatError(`${fieldName} must be a string.`);
  }
  return value.split("$$$");
}

function parseEpisodes(value: string, lineIndex: number): PlaybackEpisode[] {
  if (value.length === 0) return [];
  const episodes: PlaybackEpisode[] = [];
  for (const part of value.split("#")) {
    if (part.length === 0) continue;
    const separator = part.indexOf("$");
    if (separator < 0) {
      throw new PlaybackFormatError(
        `Playback line ${lineIndex + 1} contains an episode without a name/id separator.`,
      );
    }
    const name = part.slice(0, separator);
    const id = part.slice(separator + 1);
    if (id.trim().length === 0 || id.includes("$")) {
      throw new PlaybackFormatError(
        `Playback line ${lineIndex + 1} contains an ambiguous or empty episode id.`,
      );
    }
    episodes.push({
      index: episodes.length,
      name: name || `第 ${episodes.length + 1} 集`,
      id,
    });
  }
  return episodes;
}
