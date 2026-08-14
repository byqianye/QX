import { defaultConfigUrl, runConfigProbe } from "../src/spikes/config-probe.js";

const source = process.env.QX_FEIMAO_CANARY_URL ?? defaultConfigUrl;

try {
  const result = await runConfigProbe(source);
  if (result.summary.siteCount === 0) {
    throw new Error("Feimao canary returned a configuration with no sites");
  }
  console.log(JSON.stringify({
    canary: "feimao-config",
    source: result.source,
    siteCount: result.summary.siteCount,
    engineCounts: result.summary.engineCounts,
    trust: result.trust,
  }, null, 2));
} catch (error: unknown) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}
