import type { TvBoxConfig } from "../config/decoder.js";
import { NativeSpiderRegistry } from "./native-spider-registry.js";
import { registerBuiltInNativeApis } from "./spider-runtime.js";
import type { SpiderArtifactCache } from "./spider-artifact-cache.js";
import { ConfigSiteInspector } from "./config-site-inspector.js";
import { SpiderArtifactResolver } from "./spider-artifact-resolver.js";
import { JarInspector } from "./jar-inspector.js";
import { JsInspector } from "./js-inspector.js";
import { PythonInspector, type PythonInspectorOptions } from "./python-inspector.js";
import { RuntimeCapabilityDetector } from "./runtime-capability-detector.js";
import type {
  RuntimeAuditArtifact,
  RuntimeAuditReport,
  RuntimeAuditSummary,
  SiteRuntimeAudit,
  SiteRuntimeAuditKind,
} from "./runtime-audit-types.js";

export interface RuntimeAuditServiceOptions {
  artifactCache?: SpiderArtifactCache;
  nativeRegistry?: NativeSpiderRegistry;
  python?: PythonInspectorOptions;
  jsSupported?: boolean;
  sourceUrl?: string;
}

export class RuntimeAuditService {
  private readonly siteInspector = new ConfigSiteInspector();
  private readonly artifactResolver = new SpiderArtifactResolver();
  private readonly jarInspector = new JarInspector();
  private readonly jsInspector = new JsInspector();
  private readonly pythonInspector: PythonInspector;
  private readonly registry: NativeSpiderRegistry;
  private readonly capabilityDetector: RuntimeCapabilityDetector;

  public constructor(private readonly options: RuntimeAuditServiceOptions = {}) {
    this.registry = options.nativeRegistry ?? new NativeSpiderRegistry();
    registerBuiltInNativeApis(this.registry);
    this.pythonInspector = new PythonInspector(options.python);
    this.capabilityDetector = new RuntimeCapabilityDetector({
      nativeRegistry: this.registry,
      ...(options.artifactCache ? { artifactCache: options.artifactCache } : {}),
      jarInspector: this.jarInspector,
      jsInspector: this.jsInspector,
      pythonInspector: this.pythonInspector,
      ...(options.jsSupported === undefined ? {} : { jsSupported: options.jsSupported }),
    });
  }

  public async audit(config: TvBoxConfig, sourceUrl = this.options.sourceUrl): Promise<RuntimeAuditReport> {
    const sites: SiteRuntimeAudit[] = [];
    const artifacts = new Map<string, RuntimeAuditArtifact>();
    for (const [index, configured] of (config.sites ?? []).entries()) {
      const inspected = this.siteInspector.inspect(configured, sourceUrl, index);
      const reference = this.artifactResolver.resolve(configured, config, sourceUrl);
      const capability = await this.capabilityDetector.detect(inspected, config, reference);
      sites.push({
        siteKey: inspected.siteKey,
        siteName: inspected.siteName,
        type: inspected.type,
        api: inspected.api,
        ...(inspected.ext === undefined ? {} : { ext: inspected.ext }),
        ...(reference.spiderUrl ? { spiderUrl: reference.spiderUrl } : {}),
        ...(reference.jarUrl ? { jarUrl: reference.jarUrl } : {}),
        runtime: capability.runtime,
        searchable: inspected.searchable,
        supported: capability.supported,
        ...(capability.reason ? { reason: capability.reason } : {}),
        capabilities: capability.capabilities,
      });
      if (capability.artifact) {
        artifacts.set(capability.artifact.url, {
          url: capability.artifact.url,
          ...(reference.md5 ? { md5: reference.md5 } : {}),
          inspection: capability.artifact,
        });
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      ...(sourceUrl ? { sourceUrl } : {}),
      sites,
      summary: summarize(sites),
      artifacts: [...artifacts.values()],
    };
  }
}

function summarize(sites: readonly SiteRuntimeAudit[]): RuntimeAuditSummary {
  const runtimeCounts = emptyRuntimeCounts();
  const unsupportedReasons: Record<string, number> = {};
  for (const site of sites) {
    runtimeCounts[site.runtime] += 1;
    if (!site.supported && site.reason) unsupportedReasons[site.reason] = (unsupportedReasons[site.reason] ?? 0) + 1;
  }
  return {
    totalSites: sites.length,
    searchableSites: sites.filter((site) => site.searchable).length,
    supportedSites: sites.filter((site) => site.supported).length,
    searchableSupportedSites: sites.filter((site) => site.searchable && site.supported).length,
    runtimeCounts,
    unsupportedReasons,
  };
}

function emptyRuntimeCounts(): Record<SiteRuntimeAuditKind, number> {
  return {
    "cms-json": 0,
    "cms-xml": 0,
    native: 0,
    javascript: 0,
    "android-dex": 0,
    "jvm-jar": 0,
    python: 0,
    unknown: 0,
  };
}
