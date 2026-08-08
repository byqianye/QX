import { createDecipheriv } from "node:crypto";

import { routeSpiderApi, type SpiderEngine } from "../spider/rpc.js";

export interface TvBoxSite {
  key?: string;
  name?: string;
  type?: number;
  api?: string;
  ext?: unknown;
  jar?: string;
  searchable?: number | string;
  quickSearch?: number | string;
  filterable?: number | string;
  changeable?: number | string;
  timeout?: number | string;
  header?: unknown;
  playUrl?: string;
  categories?: unknown[];
  [key: string]: unknown;
}

export interface TvBoxConfig {
  spider?: string;
  sites?: TvBoxSite[];
  lives?: unknown[];
  parses?: unknown[];
  rules?: unknown[];
  ads?: unknown[];
  doh?: unknown[];
  [key: string]: unknown;
}

export interface ConfigSummary {
  siteCount: number;
  liveCount: number;
  parseCount: number;
  ruleCount: number;
  hasSpider: boolean;
  topLevelKeys: string[];
  engineCounts: Record<Exclude<SpiderEngine, "unknown">, number>;
}

export function decodeConfigPayload(input: string): string {
  const trimmed = input.trim();
  if (trimmed.toLowerCase().startsWith("tvbox://")) {
    return decodeBase64(trimmed.slice("tvbox://".length));
  }
  if (trimmed.startsWith("2423")) {
    return decodeFongMiCbc(trimmed);
  }
  if (trimmed.includes("**")) {
    const marker = /[A-Za-z0-9]{8}\*\*/.exec(trimmed);
    if (marker) return decodeBase64(trimmed.slice(marker.index + marker[0].length));
  }
  return trimmed.replace(/^\uFEFF/, "");
}

export function parseTvBoxConfig(input: string): TvBoxConfig {
  const decoded = decodeConfigPayload(input);
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch (error) {
    throw new Error("Configuration is not valid JSON", { cause: error });
  }
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error("Configuration must be a JSON object");
  }
  if (value.sites !== undefined && !Array.isArray(value.sites)) {
    throw new Error("Configuration sites must be an array");
  }

  return value as TvBoxConfig;
}

export function summarizeConfig(config: TvBoxConfig): ConfigSummary {
  const sites = Array.isArray(config.sites) ? config.sites : [];
  const engineCounts: ConfigSummary["engineCounts"] = {
    java: 0,
    quickjs: 0,
    python: 0,
    http: 0,
  };

  for (const site of sites) {
    if (typeof site.api !== "string") continue;
    const engine = routeSpiderApi(site.api);
    if (engine !== "unknown") engineCounts[engine] += 1;
  }

  return {
    siteCount: sites.length,
    liveCount: Array.isArray(config.lives) ? config.lives.length : 0,
    parseCount: Array.isArray(config.parses) ? config.parses.length : 0,
    ruleCount: Array.isArray(config.rules) ? config.rules.length : 0,
    hasSpider: typeof config.spider === "string" && config.spider.length > 0,
    topLevelKeys: Object.keys(config),
    engineCounts,
  };
}

function decodeFongMiCbc(input: string): string {
  const compact = input.replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(compact) || compact.length % 2 !== 0) {
    throw new Error("FongMi envelope must be an even-length hexadecimal string");
  }

  const decoded = Buffer.from(compact, "hex").toString("latin1");
  const keyStart = decoded.indexOf("$#");
  const keyEnd = decoded.indexOf("#$");
  if (keyStart < 0 || keyEnd <= keyStart + 2) {
    throw new Error("FongMi envelope is missing its key marker");
  }

  const key = pad16(decoded.slice(keyStart + 2, keyEnd));
  const iv = pad16(decoded.slice(-13));
  const cipherStart = compact.indexOf("2324");
  const cipherEnd = compact.length - 26;
  if (cipherStart < 0 || cipherEnd <= cipherStart + 4) {
    throw new Error("FongMi envelope is missing its ciphertext");
  }

  const cipherHex = compact.slice(cipherStart + 4, cipherEnd);
  if (cipherHex.length % 2 !== 0) throw new Error("FongMi ciphertext has invalid length");

  try {
    const decipher = createDecipheriv(
      "aes-128-cbc",
      Buffer.from(key, "latin1"),
      Buffer.from(iv, "latin1"),
    );
    return Buffer.concat([
      decipher.update(Buffer.from(cipherHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new Error("Unable to decrypt FongMi AES-CBC envelope", { cause: error });
  }
}

function decodeBase64(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function pad16(value: string): string {
  if (value.length > 16) throw new Error("FongMi AES key or IV is longer than 16 bytes");
  return value.padEnd(16, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
