import { existsSync } from "node:fs";

import type { TvBoxConfig } from "../config/decoder.js";
import type { NativeSpiderRegistry } from "./native-spider-registry.js";
import { JarInspector, type JarInspectionResult } from "./jar-inspector.js";
import type { SpiderArtifactCache } from "./spider-artifact-cache.js";
import type { ConfigSiteInspection } from "./config-site-inspector.js";
import { JsInspector } from "./js-inspector.js";
import { PythonInspector } from "./python-inspector.js";
import type { SpiderArtifactReference } from "./spider-artifact-resolver.js";
import type { SiteRuntimeAuditKind } from "./runtime-audit-types.js";

export interface RuntimeCapabilityDetectorOptions {
  nativeRegistry: NativeSpiderRegistry;
  artifactCache?: SpiderArtifactCache;
  jarInspector?: JarInspector;
  jsInspector?: JsInspector;
  pythonInspector?: PythonInspector;
  jsSupported?: boolean;
}

export interface RuntimeCapabilityResult {
  runtime: SiteRuntimeAuditKind;
  supported: boolean;
  reason: string;
  capabilities: {
    home: boolean;
    category: boolean;
    search: boolean;
    detail: boolean;
    player: boolean;
  };
  artifact?: JarInspectionResult;
}

export class RuntimeCapabilityDetector {
  private readonly jarInspector: JarInspector;
  private readonly jsInspector: JsInspector;
  private readonly pythonInspector: PythonInspector;
  private readonly jsSupported: boolean;

  public constructor(private readonly options: RuntimeCapabilityDetectorOptions) {
    this.jarInspector = options.jarInspector ?? new JarInspector();
    this.jsInspector = options.jsInspector ?? new JsInspector();
    this.pythonInspector = options.pythonInspector ?? new PythonInspector();
    this.jsSupported = options.jsSupported ?? true;
  }

  public async detect(
    site: ConfigSiteInspection,
    config: TvBoxConfig | undefined,
    artifact: SpiderArtifactReference,
  ): Promise<RuntimeCapabilityResult> {
    if (site.type === 0) return supported("cms-xml", "cms_xml_supported");
    if (site.type === 1 || site.type === 4) return supported("cms-json", "cms_json_supported");
    if (this.options.nativeRegistry.has(site.api)) return supported("native", "native_supported");

    const js = this.jsInspector.inspect(site.site, config);
    if (js.isJavaScript) {
      return this.jsSupported ? supported("javascript", "js_supported") : unsupported("javascript", "js_runtime_missing");
    }

    const python = await this.pythonInspector.inspect(site.site, config);
    if (python.isPython) {
      return python.available ? supported("python", "python_supported") : unsupported("python", "python_runtime_missing");
    }

    if (artifact.jarUrl) {
      const inspected = await this.inspectArtifact(artifact.jarUrl, artifact.md5);
      if (inspected.error) return unsupported("unknown", inspected.error);
      const inspection = inspected.inspection;
      if (!inspection) return unsupported("unknown", "invalid_jar");
      if (inspection.runtimeRequirement === "android-dex") {
        return {
          ...supported("android-dex", "android_dex_artifact_ready", {
            home: false,
            category: false,
            search: true,
            detail: true,
            player: true,
          }),
          artifact: inspection,
        };
      }
      if (inspection.runtimeRequirement === "mixed") {
        return {
          ...unsupported("android-dex", "mixed_spider_runtime_not_available"),
          artifact: inspection,
        };
      }
      if (inspection.runtimeRequirement === "jvm") {
        return {
          ...supported("jvm-jar", "jvm_jar_static_runtime_detected", {
            home: false,
            category: false,
            search: true,
            detail: true,
            player: false,
          }),
          artifact: inspection,
        };
      }
      return { ...unsupported("unknown", "unsupported_spider_artifact"), artifact: inspection };
    }

    if (/^csp_/i.test(site.api)) return unsupported("unknown", "spider_artifact_not_declared");
    return unsupported("unknown", "unsupported_site_type");
  }

  private async inspectArtifact(reference: string, md5?: string): Promise<{ inspection: JarInspectionResult; error?: never } | { inspection?: never; error: string }> {
    try {
      if (/^https?:\/\//i.test(reference)) {
        if (!this.options.artifactCache) return { error: "jar_download_failed" };
        const artifact = await this.options.artifactCache.get({ url: reference, ...(md5 ? { md5 } : {}) });
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

function supported(runtime: SiteRuntimeAuditKind, reason: string, capabilities = fullCapabilities()): RuntimeCapabilityResult {
  return { runtime, supported: true, reason, capabilities };
}

function unsupported(runtime: SiteRuntimeAuditKind, reason: string): RuntimeCapabilityResult {
  return { runtime, supported: false, reason, capabilities: emptyCapabilities() };
}

function fullCapabilities() {
  return { home: true, category: true, search: true, detail: true, player: true };
}

function emptyCapabilities() {
  return { home: false, category: false, search: false, detail: false, player: false };
}
