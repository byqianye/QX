import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { routeSpiderApi } from "../spider/rpc.js";
import type { TvBoxConfig } from "./decoder.js";

export type ImportSourceKind = "remote" | "local" | "inline";

export interface ImportAssessment {
  source: string;
  sourceKind: ImportSourceKind;
  executesCode: boolean;
  requiresConfirmation: boolean;
  warning: string;
}

export interface TrustPersistence {
  read(): readonly string[];
  write(sources: readonly string[]): void;
}

export class JsonFileTrustPersistence implements TrustPersistence {
  public constructor(private readonly path: string) {
  }

  public read(): readonly string[] {
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(value) || !value.every((source) => typeof source === "string")) {
        throw new Error("Trust persistence must contain a JSON string array");
      }
      return value;
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw new Error(`Unable to read trust persistence: ${this.path}`, { cause: error });
    }
  }

  public write(sources: readonly string[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify([...sources], null, 2)}\n`, "utf8");
  }
}

export class ImportTrustStore {
  private readonly trustedSources = new Set<string>();

  public constructor(private readonly persistence?: TrustPersistence) {
    for (const source of persistence?.read() ?? []) {
      this.trustedSources.add(source);
    }
  }

  trust(source: string): void {
    this.trustedSources.add(source);
    this.persist();
  }

  revoke(source: string): void {
    this.trustedSources.delete(source);
    this.persist();
  }

  isTrusted(source: string): boolean {
    return this.trustedSources.has(source);
  }

  private persist(): void {
    this.persistence?.write([...this.trustedSources]);
  }
}

export function inspectImport(
  source: string,
  config: TvBoxConfig,
  trustStore: ImportTrustStore,
): ImportAssessment {
  const sourceKind = sourceKindOf(source);
  const sites = Array.isArray(config.sites) ? config.sites : [];
  const executesCode = Boolean(config.spider) || sites.some((site) => {
    if (typeof site.api !== "string") return false;
    return ["java", "quickjs", "python"].includes(routeSpiderApi(site.api));
  });
  const requiresConfirmation = executesCode && !trustStore.isTrusted(source);

  return {
    source,
    sourceKind,
    executesCode,
    requiresConfirmation,
    warning: executesCode
      ? "此配置包含会在本机执行的 Spider 代码；首次导入前必须明确确认并信任来源。"
      : "此配置不包含已识别的脚本 Spider。",
  };
}

function sourceKindOf(source: string): ImportSourceKind {
  if (/^https?:\/\//i.test(source)) return "remote";
  if (/^file:\/\//i.test(source) || /^[a-zA-Z]:[\\/]/.test(source)) return "local";
  return "inline";
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
