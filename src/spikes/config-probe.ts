import { parseTvBoxConfig, summarizeConfig } from "../config/decoder.js";
import { ImportTrustStore, inspectImport } from "../config/trust.js";

export const defaultConfigUrl = "http://xn--z7x900a.net/";

export async function runConfigProbe(url = process.env.QX_SPIKE_CONFIG_URL ?? defaultConfigUrl) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Config request failed: HTTP ${response.status}`);

  const raw = await response.text();
  const config = parseTvBoxConfig(raw);
  const summary = summarizeConfig(config);
  const trust = inspectImport(url, config, new ImportTrustStore());

  return {
    probe: "config",
    source: url,
    response: {
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: Buffer.byteLength(raw, "utf8"),
    },
    summary,
    trust,
    samples: (config.sites ?? []).slice(0, 8).map((site) => ({
      key: site.key,
      name: site.name,
      api: site.api,
    })),
  };
}

if (isMain()) {
  runConfigProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}

function isMain(): boolean {
  return process.argv[1]?.endsWith("config-probe.ts") ?? false;
}
