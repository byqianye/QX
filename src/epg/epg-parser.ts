import { SaxesParser, type SaxesTag } from "saxes";

import { normalizeChannelName } from "../live/live-parser.js";
import type {
  EpgChannelRecord,
  EpgImportIssue,
  EpgProgrammeRecord,
} from "./epg-types.js";

export interface EpgParserOptions {
  maxChannels?: number;
  maxProgrammes?: number;
  maxTextBytes?: number;
}

export interface EpgParseResult {
  channels: readonly EpgChannelRecord[];
  programmes: readonly EpgProgrammeRecord[];
  issues: readonly EpgImportIssue[];
}

export class EpgParserError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EpgParserError";
    this.code = code;
  }
}

interface ElementFrame {
  name: string;
  attributes: Record<string, string>;
  text: string;
}

interface MutableChannel {
  externalId: string;
  displayNames: string[];
  icon: string | null;
}

interface MutableProgramme {
  externalId: string;
  start: string;
  stop: string;
  title: string | null;
  subTitle: string | null;
  description: string | null;
  categories: string[];
  icon: string | null;
}

const DEFAULT_MAX_CHANNELS = 10_000;
const DEFAULT_MAX_PROGRAMMES = 100_000;
const DEFAULT_MAX_TEXT_BYTES = 16 * 1024 * 1024;

export function parseXmltv(content: string, options: EpgParserOptions = {}): EpgParseResult {
  const maxChannels = positiveLimit(options.maxChannels, DEFAULT_MAX_CHANNELS);
  const maxProgrammes = positiveLimit(options.maxProgrammes, DEFAULT_MAX_PROGRAMMES);
  const maxTextBytes = positiveLimit(options.maxTextBytes, DEFAULT_MAX_TEXT_BYTES);
  const channels: EpgChannelRecord[] = [];
  const programmes: EpgProgrammeRecord[] = [];
  const issues: EpgImportIssue[] = [];
  const stack: ElementFrame[] = [];
  let currentChannel: MutableChannel | null = null;
  let currentProgramme: MutableProgramme | null = null;
  let textBytes = 0;

  const parser = new SaxesParser({ xmlns: false, fragment: false, position: true });
  parser.on("doctype", () => {
    throw new EpgParserError("EPG_XML_UNSAFE", "XMLTV 不允许使用 DTD 或外部实体。");
  });
  parser.on("error", (error) => {
    throw new EpgParserError("EPG_PARSE_FAILED", "XMLTV 不是有效的 XML。", { cause: error });
  });
  parser.on("opentag", (tag) => {
    const name = localName(tag.name);
    const attributes = plainAttributes(tag);
    const attributeBytes = Buffer.byteLength(JSON.stringify(attributes), "utf8");
    if (attributeBytes > maxTextBytes) throw new EpgParserError("EPG_TOO_LARGE", "XMLTV 属性文本超过限制。");
    stack.push({ name, attributes, text: "" });
    if (name === "channel") {
      const externalId = attributes.id?.trim() ?? "";
      if (!externalId) {
        issues.push(issue("EPG_CHANNEL_ID_MISSING", "XMLTV channel 缺少 id。", parser.line));
        currentChannel = null;
        return;
      }
      if (channels.length >= maxChannels) throw new EpgParserError("EPG_TOO_LARGE", "XMLTV channel 数量超过限制。");
      currentChannel = { externalId, displayNames: [], icon: null };
    } else if (name === "programme") {
      const externalId = attributes.channel?.trim() ?? "";
      const start = attributes.start?.trim() ?? "";
      const stop = attributes.stop?.trim() ?? "";
      if (!externalId || !start || !stop) {
        currentProgramme = null;
        issues.push(issue("EPG_PROGRAMME_INVALID", "XMLTV programme 缺少 channel、start 或 stop。", parser.line));
        return;
      }
      if (programmes.length >= maxProgrammes) throw new EpgParserError("EPG_TOO_LARGE", "XMLTV programme 数量超过限制。");
      currentProgramme = {
        externalId,
        start,
        stop,
        title: null,
        subTitle: null,
        description: null,
        categories: [],
        icon: null,
      };
    }
  });
  const handleText = (value: string): void => {
    textBytes += Buffer.byteLength(value, "utf8");
    if (textBytes > maxTextBytes) throw new EpgParserError("EPG_TOO_LARGE", "XMLTV 文本超过限制。");
    const frame = stack[stack.length - 1];
    if (frame) frame.text += value;
  };
  parser.on("text", handleText);
  parser.on("cdata", handleText);
  parser.on("closetag", (rawName) => {
    const frame = stack.pop();
    if (!frame) throw new EpgParserError("EPG_PARSE_FAILED", "XMLTV 标签结构无效。");
    const text = normalizeText(frame.text);
    const parent = stack[stack.length - 1]?.name;
    if (currentChannel && parent === "channel") {
      if (frame.name === "display-name" && text) currentChannel.displayNames.push(text);
      if (frame.name === "icon") currentChannel.icon = safeIcon(frame.attributes.src) ?? currentChannel.icon;
    }
    if (currentProgramme && parent === "programme") {
      if (frame.name === "title" && text) currentProgramme.title = text;
      if (frame.name === "sub-title" && text) currentProgramme.subTitle = text;
      if (frame.name === "desc" && text) currentProgramme.description = text;
      if (frame.name === "category" && text) currentProgramme.categories.push(text);
      if (frame.name === "icon") currentProgramme.icon = safeIcon(frame.attributes.src) ?? currentProgramme.icon;
    }
    if (frame.name === "channel" && currentChannel) {
      const displayName = currentChannel.displayNames[0] ?? currentChannel.externalId;
      channels.push({
        id: "",
        sourceId: "",
        externalId: currentChannel.externalId,
        displayName,
        displayNames: [...currentChannel.displayNames],
        normalizedName: normalizeChannelName(displayName),
        icon: currentChannel.icon,
      });
      currentChannel = null;
    }
    if (frame.name === "programme" && currentProgramme) {
      const parsedStart = parseXmltvTime(currentProgramme.start);
      const parsedStop = parseXmltvTime(currentProgramme.stop);
      if (parsedStart === null || parsedStop === null || parsedStop <= parsedStart || !currentProgramme.title) {
        issues.push(issue("EPG_PROGRAMME_INVALID", "XMLTV programme 时间或标题无效。", parser.line));
      } else {
        programmes.push({
          id: "",
          sourceId: "",
          channelId: currentProgramme.externalId,
          startAt: parsedStart,
          endAt: parsedStop,
          title: currentProgramme.title,
          subTitle: currentProgramme.subTitle,
          description: currentProgramme.description,
          categories: [...new Set(currentProgramme.categories)],
          icon: currentProgramme.icon,
        });
      }
      currentProgramme = null;
    }
    if (rawName && localName(rawName.name) !== frame.name) {
      throw new EpgParserError("EPG_PARSE_FAILED", "XMLTV 标签闭合不匹配。");
    }
  });

  try {
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < content.length; offset += chunkSize) parser.write(content.slice(offset, offset + chunkSize));
    parser.close();
  } catch (error) {
    if (error instanceof EpgParserError) throw error;
    throw new EpgParserError("EPG_PARSE_FAILED", "XMLTV 解析失败。", { cause: error });
  }

  const channelIds = new Set(channels.map((channel) => channel.externalId));
  const filteredProgrammes = programmes.filter((programme) => {
    if (channelIds.has(programme.channelId)) return true;
    issues.push(issue("EPG_PROGRAMME_CHANNEL_UNKNOWN", "programme 引用了未知 channel。", null));
    return false;
  });
  if (channels.length === 0) throw new EpgParserError("EPG_PARSE_FAILED", "XMLTV 没有可用 channel。");
  return { channels, programmes: filteredProgrammes, issues };
}

export function parseXmltvTime(value: string): number | null {
  const normalized = value.trim().replace(/\s+/gu, " ");
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*(Z|UTC|([+-])(\d{2}):?(\d{2})))?$/iu.exec(normalized);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);
  if (offsetHours > 23 || offsetMinutes > 59 || hour > 23 || minute > 59 || second > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(utc);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const sign = match[8] === "-" ? -1 : 1;
  return utc - sign * (offsetHours * 60 + offsetMinutes) * 60_000;
}

function plainAttributes(tag: SaxesTag): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(tag.attributes)) {
    attributes[key] = typeof value === "string" ? value : value.value;
  }
  return attributes;
}

function localName(value: string): string {
  return value.split(":").pop()?.toLocaleLowerCase() ?? value.toLocaleLowerCase();
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function safeIcon(value: string | undefined): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function issue(code: string, message: string, line: number | null): EpgImportIssue {
  return { code, message, line, raw: null };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
