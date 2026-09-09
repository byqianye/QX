import type { JarInspectionResult } from "./jar-inspector.js";

export type SiteRuntimeAuditKind =
  | "cms-json"
  | "cms-xml"
  | "native"
  | "javascript"
  | "jvm-jar"
  | "python"
  | "unknown";

export interface SiteRuntimeAudit {
  siteKey: string;
  siteName: string;
  type: number;
  api: string;
  ext?: unknown;
  spiderUrl?: string;
  jarUrl?: string;
  runtime: SiteRuntimeAuditKind;
  searchable: boolean;
  supported: boolean;
  reason?: string;
  capabilities: {
    home: boolean;
    category: boolean;
    search: boolean;
    detail: boolean;
    player: boolean;
  };
}

export interface RuntimeAuditSummary {
  totalSites: number;
  searchableSites: number;
  supportedSites: number;
  searchableSupportedSites: number;
  runtimeCounts: Record<SiteRuntimeAuditKind, number>;
  unsupportedReasons: Record<string, number>;
}

export interface RuntimeAuditArtifact {
  url: string;
  md5?: string;
  inspection: JarInspectionResult;
}

export interface RuntimeAuditReport {
  generatedAt: string;
  sourceUrl?: string;
  sites: readonly SiteRuntimeAudit[];
  summary: RuntimeAuditSummary;
  artifacts: readonly RuntimeAuditArtifact[];
}
