import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseTvBoxConfig } from "../config/decoder.js";
import { SpiderArtifactCache } from "../spider/spider-artifact-cache.js";
import { RuntimeAuditService } from "../spider/runtime-audit-service.js";
import { renderRuntimeAuditMarkdown } from "../spider/runtime-audit-report.js";
import { defaultConfigUrl } from "./config-probe.js";

export async function runRuntimeAudit(
  sourceUrl = process.env.QX_RUNTIME_AUDIT_CONFIG_URL ?? defaultConfigUrl,
  outputRoot = process.env.QX_RUNTIME_AUDIT_OUTPUT ?? process.cwd(),
): Promise<void> {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Configuration request failed: HTTP ${response.status}`);
  const config = parseTvBoxConfig(await response.text());
  const cacheRoot = process.env.QX_RUNTIME_AUDIT_CACHE ?? join(tmpdir(), "qx-runtime-audit-cache");
  await mkdir(cacheRoot, { recursive: true });
  const report = await new RuntimeAuditService({
    artifactCache: new SpiderArtifactCache(cacheRoot),
    sourceUrl,
  }).audit(config, sourceUrl);
  await writeFile(join(outputRoot, "runtime-audit.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(outputRoot, "RUNTIME-AUDIT.md"), renderRuntimeAuditMarkdown(report), "utf8");
  console.log(JSON.stringify(report.summary, null, 2));
}

if (process.argv[1]?.endsWith("runtime-audit.ts")) {
  runRuntimeAudit().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
