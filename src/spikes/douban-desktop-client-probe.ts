import { runDoubanSearchDetailSidecarProbe } from "./douban-search-detail-sidecar-probe.js";

export async function runDoubanDesktopClientProbe() {
  const result = await runDoubanSearchDetailSidecarProbe();
  return {
    ...result,
    probe: "desktop-jvm-csp-douban-search-detail",
  };
}

if (process.argv[1]?.endsWith("douban-desktop-client-probe.ts")) {
  runDoubanDesktopClientProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
