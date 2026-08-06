import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { routeSpiderApi } from "../spider/rpc.js";
import type { TvBoxConfig } from "./decoder.js";

export type ImportSourceKind = "remote" | "local" | "inline";

export interface ImportAssessment {
  source: string;
  sourceKind: ImportSourceKind;
  executesCode: boolean;
  requiresConfirmation: boolean;
  warning: string;
  configHash: string;
  trustFingerprint: string;
  engines: readonly string[];
  spiderSources: readonly string[];
  spiderHashes: Readonly<Record<string, string>>;
  allowedDomains: readonly string[];
  usesCookie: boolean;
  requestsLocalService: boolean;
  fileChanged: boolean;
  lastTrustedAt: number | null;
}

export interface TrustRecord {
  source: string;
  fingerprint: string;
  configHash: string;
  spiderHashes: Readonly<Record<string, string>>;
  engines: readonly string[];
  allowedDomains: readonly string[];
  usesCookie: boolean;
  requestsLocalService: boolean;
  trustedAt: number;
}

export interface TrustPersistence {
  read(): readonly (string | TrustRecord)[];
  write(records: readonly TrustRecord[]): void;
}

export class JsonFileTrustPersistence implements TrustPersistence {
  public constructor(private readonly path: string) {
  }

  public read(): readonly (string | TrustRecord)[] {
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string" || isTrustRecord(item))) {
        throw new Error("Trust persistence must contain trust records");
      }
      return value;
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw new Error(`Unable to read trust persistence: ${this.path}`, { cause: error });
    }
  }

  public write(records: readonly TrustRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }
}

export class ImportTrustStore {
  private readonly trustedRecords = new Map<string, TrustRecord>();

  public constructor(private readonly persistence?: TrustPersistence) {
    for (const value of persistence?.read() ?? []) {
      const record = typeof value === "string" ? legacyTrustRecord(value) : value;
      this.trustedRecords.set(sourceKey(record.source), record);
    }
  }

  /**
   * The no-assessment overload remains for old callers. New import flows pass
   * the assessment so the persisted decision is bound to content hashes.
   */
  public trust(source: string, assessment?: ImportAssessment): void {
    const record = assessment && sourceKey(assessment.source) === sourceKey(source)
      ? recordFromAssessment(assessment)
      : legacyTrustRecord(source);
    this.trustedRecords.set(sourceKey(source), record);
    this.persist();
  }

  public trustAssessment(assessment: ImportAssessment): void {
    this.trustedRecords.set(sourceKey(assessment.source), recordFromAssessment(assessment));
    this.persist();
  }

  public revoke(source: string): void {
    this.trustedRecords.delete(sourceKey(source));
    this.persist();
  }

  public isTrusted(source: string, fingerprint?: string): boolean {
    const record = this.trustedRecords.get(sourceKey(source));
    if (!record) return false;
    if (fingerprint !== undefined && Object.values(record.spiderHashes).some((hash) => hash.startsWith("unavailable:"))) {
      return false;
    }
    return fingerprint === undefined || record.fingerprint === fingerprint;
  }

  public getRecord(source: string): TrustRecord | undefined {
    const record = this.trustedRecords.get(sourceKey(source));
    return record ? cloneRecord(record) : undefined;
  }

  public records(): readonly TrustRecord[] {
    return [...this.trustedRecords.values()].map(cloneRecord);
  }

  private persist(): void {
    this.persistence?.write(this.records());
  }
}

export function inspectImport(
  source: string,
  config: TvBoxConfig,
  trustStore: ImportTrustStore,
): ImportAssessment {
  return buildAssessment(source, config, trustStore, new Map());
}

export interface AsyncTrustInspectionOptions {
  fetchText?: (url: string) => Promise<string>;
}

export async function inspectImportAsync(
  source: string,
  config: TvBoxConfig,
  trustStore: ImportTrustStore,
  options: AsyncTrustInspectionOptions = {},
): Promise<ImportAssessment> {
  const hashes = new Map<string, string>();
  for (const reference of spiderReferences(config)) {
    hashes.set(reference, await hashReference(reference, options.fetchText));
  }
  return buildAssessment(source, config, trustStore, hashes);
}

function buildAssessment(
  source: string,
  config: TvBoxConfig,
  trustStore: ImportTrustStore,
  asyncHashes: Map<string, string>,
): ImportAssessment {
  const sourceKind = sourceKindOf(source);
  const sites = Array.isArray(config.sites) ? config.sites : [];
  const engines = new Set<string>();
  for (const site of sites) {
    if (typeof site.api !== "string") continue;
    const routed = routeSpiderApi(site.api);
    if (routed !== "unknown") engines.add(routed);
  }
  if (typeof config.spider === "string" && config.spider.trim()) {
    const routed = routeSpiderApi(config.spider);
    engines.add(routed === "unknown" && /\.(?:jar|dex)(?:[?#].*)?$/i.test(config.spider) ? "java" : routed);
  }

  const spiderSources = spiderReferences(config);
  const spiderHashes: Record<string, string> = {};
  for (const reference of spiderSources) {
    spiderHashes[safeSourceLabel(reference)] = asyncHashes.get(reference) ?? hashReferenceSync(reference);
  }
  const configHash = digest(stableJson(config));
  const allowedDomains = extractDomains(config);
  const usesCookie = /cookie|authorization|bearer|token|secret|password/i.test(stableJson(config));
  const requestsLocalService = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|file:\/\/)/i.test(stableJson(config));
  const executesCode = Boolean(config.spider) || engines.has("java") || engines.has("quickjs") || engines.has("python");
  const trustFingerprint = digest(stableJson({
    configHash,
    engines: [...engines].sort(),
    spiderHashes,
    allowedDomains,
    usesCookie,
    requestsLocalService,
  }));
  const previous = trustStore.getRecord(source);
  const fileChanged = previous !== undefined
    && previous.fingerprint !== "*"
    && previous.fingerprint !== trustFingerprint;
  const requiresConfirmation = executesCode && !trustStore.isTrusted(source, trustFingerprint);

  return {
    source,
    sourceKind,
    executesCode,
    requiresConfirmation,
    warning: executesCode
      ? trustWarning({ engines: [...engines], allowedDomains, usesCookie, requestsLocalService, fileChanged })
      : "此配置不包含已识别的脚本 Spider。",
    configHash,
    trustFingerprint,
    engines: [...engines].sort(),
    spiderSources: spiderSources.map(safeSourceLabel),
    spiderHashes,
    allowedDomains,
    usesCookie,
    requestsLocalService,
    fileChanged,
    lastTrustedAt: previous && previous.trustedAt > 0 ? previous.trustedAt : null,
  };
}

function trustWarning(value: {
  engines: readonly string[];
  allowedDomains: readonly string[];
  usesCookie: boolean;
  requestsLocalService: boolean;
  fileChanged: boolean;
}): string {
  const changed = value.fileChanged ? "脚本或配置内容已变化，必须重新确认。" : "首次运行前必须明确确认。";
  const domains = value.allowedDomains.length > 0 ? value.allowedDomains.join(", ") : "未声明域名";
  return `此配置会执行 ${value.engines.join(", ") || "未知"} 引擎代码；允许访问域名：${domains}；Cookie：${value.usesCookie ? "是" : "否"}；本地服务：${value.requestsLocalService ? "是" : "否"}。${changed}`;
}

function spiderReferences(config: TvBoxConfig): string[] {
  const result = new Set<string>();
  if (typeof config.spider === "string" && config.spider.trim()) result.add(stripEnginePrefix(config.spider.trim()));
  for (const site of Array.isArray(config.sites) ? config.sites : []) {
    for (const key of ["api", "script", "spider"]) {
      const value = site[key];
      if (typeof value !== "string" || !value.trim()) continue;
      const route = routeSpiderApi(value);
      if (["java", "quickjs", "python"].includes(route) || /\.(?:jar|dex|js|mjs|py)(?:[?#].*)?$/i.test(value)) {
        result.add(stripEnginePrefix(value.trim()));
      }
    }
  }
  return [...result];
}

async function hashReference(reference: string, fetchText?: (url: string) => Promise<string>): Promise<string> {
  const localPath = localPathOf(reference);
  if (localPath) {
    try {
      return digest(await readFile(localPath));
    } catch {
      return `unavailable:${safeSourceLabel(reference)}`;
    }
  }
  if (/^https?:\/\//i.test(reference) && fetchText) {
    try {
      return digest(await fetchText(reference));
    } catch {
      return `unavailable:${safeSourceLabel(reference)}`;
    }
  }
  return digest(reference);
}

function hashReferenceSync(reference: string): string {
  const localPath = localPathOf(reference);
  if (localPath) {
    try {
      return digest(readFileSync(localPath));
    } catch {
      return `unavailable:${safeSourceLabel(reference)}`;
    }
  }
  if (/^https?:\/\//i.test(reference)) return `unavailable:${safeSourceLabel(reference)}`;
  return digest(reference);
}

function localPathOf(reference: string): string | undefined {
  try {
    if (/^file:\/\//i.test(reference)) return fileURLToPath(reference);
    const path = resolve(reference);
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

function extractDomains(config: TvBoxConfig): string[] {
  const domains = new Set<string>();
  const text = stableJson(config);
  for (const match of text.matchAll(/https?:\/\/([^/"\\\s]+)/gi)) {
    const host = match[1]?.split(":", 1)[0];
    if (host) domains.add(host.toLowerCase());
  }
  return [...domains].sort();
}

function recordFromAssessment(assessment: ImportAssessment): TrustRecord {
  return {
    source: safeSourceLabel(assessment.source),
    fingerprint: assessment.trustFingerprint,
    configHash: assessment.configHash,
    spiderHashes: { ...assessment.spiderHashes },
    engines: [...assessment.engines],
    allowedDomains: [...assessment.allowedDomains],
    usesCookie: assessment.usesCookie,
    requestsLocalService: assessment.requestsLocalService,
    trustedAt: Date.now(),
  };
}

function legacyTrustRecord(source: string): TrustRecord {
  return {
    source: safeSourceLabel(source),
    fingerprint: "legacy",
    configHash: "legacy",
    spiderHashes: {},
    engines: [],
    allowedDomains: [],
    usesCookie: false,
    requestsLocalService: false,
    trustedAt: 0,
  };
}

function cloneRecord(record: TrustRecord): TrustRecord {
  return {
    ...record,
    spiderHashes: { ...record.spiderHashes },
    engines: [...record.engines],
    allowedDomains: [...record.allowedDomains],
  };
}

function safeSourceLabel(source: string): string {
  try {
    const url = new URL(source);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch {
    // Keep non-URL source identifiers such as inline hashes.
  }
  return source;
}

function sourceKey(source: string): string {
  return safeSourceLabel(source);
}

function stripEnginePrefix(value: string): string {
  return /^(?:js|py):/i.test(value) ? value.slice(3).trim() : value;
}

function sourceKindOf(source: string): ImportSourceKind {
  if (/^https?:\/\//i.test(source)) return "remote";
  if (/^file:\/\//i.test(source) || /^[a-zA-Z]:[\\/]/.test(source)) return "local";
  return "inline";
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function isTrustRecord(value: unknown): value is TrustRecord {
  return isRecord(value)
    && typeof value.source === "string"
    && typeof value.fingerprint === "string"
    && typeof value.configHash === "string"
    && isStringRecord(value.spiderHashes)
    && Array.isArray(value.engines) && value.engines.every((item) => typeof item === "string")
    && Array.isArray(value.allowedDomains) && value.allowedDomains.every((item) => typeof item === "string")
    && typeof value.usesCookie === "boolean"
    && typeof value.requestsLocalService === "boolean"
    && typeof value.trustedAt === "number";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
