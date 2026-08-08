import type { RuntimeAuditReport, SiteRuntimeAudit } from "./runtime-audit-types.js";

export function renderRuntimeAuditMarkdown(report: RuntimeAuditReport): string {
  const summary = report.summary;
  const lines = [
    "# QX Spider Runtime Audit",
    "",
    `Audit date: ${report.generatedAt}`,
    report.sourceUrl ? `Configuration source: \`${report.sourceUrl}\`` : "Configuration source: not specified",
    "",
    "The audit resolves configuration sites, downloads declared Spider artifacts when available, and performs static ZIP/JAR inspection only. No JAR, DEX, emulator, class loader, or third-party converter is executed.",
    "",
    "## Summary",
    "",
    "| Metric | Result |",
    "| --- | ---: |",
    `| Configured sites | ${summary.totalSites} |`,
    `| Searchable sites | ${summary.searchableSites} |`,
    `| Supported sites | ${summary.supportedSites} |`,
    `| Searchable sites supported by QX | ${summary.searchableSupportedSites} |`,
    "",
    "| Runtime | Count |",
    "| --- | ---: |",
    ...Object.entries(summary.runtimeCounts).map(([runtime, count]) => `| ${runtime} | ${count} |`),
    "",
    "## Artifact evidence",
    "",
    ...(report.artifacts.length === 0
      ? ["No Spider artifact was inspected.", ""]
      : report.artifacts.flatMap((artifact) => [
          `- URL: \`${artifact.url}\``,
          ...(artifact.md5 ? [`- Declared MD5: \`${artifact.md5}\``] : []),
          `- Size: ${artifact.inspection.size} bytes`,
          `- SHA-256: \`${artifact.inspection.sha256}\``,
          `- Format: ${artifact.inspection.format.toUpperCase()}`,
          `- classes.dex: ${artifact.inspection.hasClassesDex ? "yes" : "no"}`,
          `- JVM .class: ${artifact.inspection.hasJvmClasses ? "yes" : "no"}`,
          `- Runtime requirement: ${artifact.inspection.runtimeRequirement}`,
          `- Native libraries: ${artifact.inspection.nativeLibraries.length}`,
          `- Assets: ${artifact.inspection.assets.length > 0 ? artifact.inspection.assets.map((asset) => `\`${asset}\``).join(", ") : "none"}`,
          "",
        ])),
    "## Per-site result",
    "",
    "| # | Key | Name | Type | API | Searchable | Runtime | Supported | Reason | Capabilities |",
    "| ---: | --- | --- | ---: | --- | :---: | --- | :---: | --- | --- |",
    ...report.sites.map((site, index) => `| ${index} | ${cell(site.siteKey)} | ${cell(site.siteName)} | ${site.type} | ${cell(site.api)} | ${site.searchable ? "yes" : "no"} | ${site.runtime} | ${site.supported ? "yes" : "no"} | ${cell(site.reason ?? "")} | ${capabilities(site)} |`),
    "",
    "## Gate decision",
    "",
    gateDecision(report),
  ];
  return `${lines.join("\n")}\n`;
}

function capabilities(site: SiteRuntimeAudit): string {
  return ["home", "category", "search", "detail", "player"]
    .filter((key) => site.capabilities[key as keyof SiteRuntimeAudit["capabilities"]])
    .join(", ") || "none";
}

function gateDecision(report: RuntimeAuditReport): string {
  const dex = report.summary.runtimeCounts["android-dex"];
  const ratio = report.summary.totalSites === 0 ? 0 : dex / report.summary.totalSites;
  if (ratio >= 0.8) return `Android DEX accounts for ${dex}/${report.summary.totalSites} sites (${(ratio * 100).toFixed(2)}%). Proceed to G83 Android DEX PoC.`;
  return `Android DEX accounts for ${dex}/${report.summary.totalSites} sites (${(ratio * 100).toFixed(2)}%). Continue with the JS/CMS runtime goals before G83.`;
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
