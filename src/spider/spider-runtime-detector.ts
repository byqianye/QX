import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import type { TvBoxConfig, TvBoxSite } from "../config/decoder.js";
import { normalizeFongMiSite } from "../config/fongmi.js";
import type { SourceCapabilities } from "../source/media-source.js";
import { JarInspector, type JarInspectionResult } from "./jar-inspector.js";
import { NativeSpiderRegistry } from "./native-spider-registry.js";
import type { SpiderArtifactCache } from "./spider-artifact-cache.js";
import {
  runtimeCapabilities,
  type RuntimeSupport,
  type SpiderRuntimeKind,
} from "./runtime-types.js";

export interface SpiderRuntimeDetectorOptions {
  nativeRegistry?: NativeSpiderRegistry;
  jarInspector?: JarInspector;
  artifactCache?: SpiderArtifactCache;
  pythonAvailable?: boolean | (() => boolean | Promise<boolean>);
  jsSupported?: boolean;
}

export interface SpiderRuntimeDetectionContext {
  config?: TvBoxConfig;
  sourceUrl?: string;
}

export class SpiderRuntimeDetector {
  private readonly nativeRegistry: NativeSpiderRegistry;
  private readonly jarInspector: JarInspector;
  private readonly artifactCache: SpiderArtifactCache | undefined;
  private readonly pythonAvailable: boolean | (() => boolean | Promise<boolean>);
  private readonly jsSupported: boolean;

  public constructor(options: SpiderRuntimeDetectorOptions = {}) {
    this.nativeRegistry = options.nativeRegistry ?? new NativeSpiderRegistry();
    this.jarInspector = options.jarInspector ?? new JarInspector();
    this.artifactCache = options.artifactCache;
    this.pythonAvailable = options.pythonAvailable ?? defaultPythonAvailable;
    this.jsSupported = options.jsSupported ?? true;
  }

  public async detect(site: TvBoxSite, context: SpiderRuntimeDetectionContext = {}): Promise<RuntimeSupport> {
    const normalized = normalizeFongMiSite(site, context.sourceUrl);
    if (normalized.type === 0 || normalized.type === 1 || normalized.type === 4) {
      return supported("cms", "cms_supported", runtimeCapabilities("http", {
        home: true,
        category: true,
        search: true,
        detail: true,
        player: true,
        filters: normalized.filterable,
        pagination: true,
      }));
    }

    const api = typeof site.api === "string" ? site.api.trim() : "";
    if (this.nativeRegistry.has(api)) {
      return supported("native", "native_supported", runtimeCapabilities("jvm", {
        home: true,
        category: true,
        search: true,
        detail: true,
        player: true,
        pagination: true,
      }));
    }

    if (isJavaScriptReference(site, context.config)) {
      return this.jsSupported
        ? supported("javascript", "js_supported", runtimeCapabilities("quickjs", {
            home: true,
            category: true,
            search: true,
            detail: true,
            player: true,
            localProxy: true,
            pagination: true,
          }))
        : unsupported("javascript", "js_runtime_missing");
    }
    if (isPythonReference(site, context.config)) {
      const available = typeof this.pythonAvailable === "function"
        ? await this.pythonAvailable()
        : this.pythonAvailable;
      return available
        ? supported("python", "python_supported", runtimeCapabilities("python", {
            home: true,
            category: true,
            search: true,
            detail: true,
            player: true,
            localProxy: true,
            pagination: true,
          }))
        : unsupported("python", "python_runtime_missing");
    }

    if (normalized.type === 3 && /^csp_/i.test(api)) {
      const artifactReference = artifactReferenceOf(site, context.config);
      if (artifactReference) {
        const artifact = await this.inspectArtifact(artifactReference.reference, artifactReference.md5);
        if (artifact.error) return unsupported("unsupported", artifact.error, undefined, artifact.inspection);
        if (artifact.inspection?.runtimeRequirement === "jvm") {
          return supported("native", "native_jvm_jar_supported", runtimeCapabilities("jvm", {
            search: true,
            detail: true,
            pagination: true,
          }), artifact.inspection);
        }
        if (artifact.inspection?.runtimeRequirement === "android-dex") {
          return unsupported("android-dex", "android_dex_runtime_not_available", undefined, artifact.inspection);
        }
        if (artifact.inspection?.runtimeRequirement === "mixed") {
          return unsupported("android-dex", "mixed_spider_runtime_not_available", undefined, artifact.inspection);
        }
        return unsupported("unsupported", "unsupported_site_type", undefined, artifact.inspection);
      }
      return unsupported("android-dex", "android_dex_runtime_not_available");
    }
    return unsupported("unsupported", "unsupported_site_type");
  }

  private async inspectArtifact(reference: string, md5?: string): Promise<{ inspection?: JarInspectionResult; error?: string }> {
    try {
      if (/^https?:\/\//i.test(reference)) {
        if (!this.artifactCache) return { error: "jar_download_failed" };
        const artifact = await this.artifactCache.get({ url: reference, ...(md5 ? { md5 } : {}) });
        return { inspection: await this.jarInspector.inspectFile(artifact.path, reference) };
      }
      if (!existsSync(reference)) return { error: "jar_download_failed" };
      return { inspection: await this.jarInspector.inspectFile(reference, reference) };
    } catch (error) {
      const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "invalid_jar";
      return { error: code };
    }
  }
}

function supported(runtime: SpiderRuntimeKind, reason: string, capabilities: SourceCapabilities, artifact?: JarInspectionResult): RuntimeSupport {
  return { runtime, supported: true, reason, capabilities, ...(artifact ? { artifact } : {}) };
}

function unsupported(runtime: SpiderRuntimeKind, reason: string, capabilities?: SourceCapabilities, artifact?: JarInspectionResult): RuntimeSupport {
  return {
    runtime,
    supported: false,
    reason,
    capabilities: capabilities ?? runtimeCapabilities("jvm"),
    ...(artifact ? { artifact } : {}),
  };
}

function artifactReferenceOf(site: TvBoxSite, config?: TvBoxConfig): { reference: string; md5?: string } | undefined {
  const md5 = typeof site.md5 === "string"
    ? site.md5
    : typeof site.hash === "string" ? site.hash : undefined;
  const candidates = [site.jar, site.spider, config?.spider, site.api];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const value = candidate.replace(/^(?:js|py):/i, "").trim();
    const declared = /^([^;]+);(?:md5|sha1|sha256);([\da-f]+)$/i.exec(value);
    const reference = declared?.[1]?.trim() ?? value;
    const declaredMd5 = declared?.[2] && declared[2].length === 32 ? declared[2] : md5;
    if (/^https?:\/\//i.test(reference) || /\.(?:jar|dex)(?:$|[?#])/i.test(reference) || existsSync(reference)) {
      return { reference, ...(declaredMd5 ? { md5: declaredMd5 } : {}) };
    }
  }
  return undefined;
}

function isJavaScriptReference(site: TvBoxSite, config?: TvBoxConfig): boolean {
  return references(site, config).some((value) => /^js:/i.test(value) || /\.m?js(?:$|[?#])/i.test(value));
}

function isPythonReference(site: TvBoxSite, config?: TvBoxConfig): boolean {
  return references(site, config).some((value) => /^py:/i.test(value) || /\.py(?:$|[?#])/i.test(value));
}

function references(site: TvBoxSite, config?: TvBoxConfig): string[] {
  return [site.api, site.ext, site.script, site.spider, config?.spider]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

function defaultPythonAvailable(): boolean {
  const executable = process.env.QX_PYTHON?.trim() || "python";
  return spawnSync(executable, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;
}
