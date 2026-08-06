import { readFile } from "node:fs/promises";
import { getQuickJS } from "quickjs-emscripten";

export async function runJsProbe() {
  const spiderSource = await readFile("fixtures/spiders/echo.js", "utf8");
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setModuleLoader((moduleName) => {
    if (moduleName === "./spider.js" || moduleName === "spider.js") return spiderSource;
    throw new Error(`Unexpected QuickJS module: ${moduleName}`);
  });

  const context = runtime.newContext();
  const reqHandle = context.newFunction("req", (urlHandle) => {
    const url = context.getString(urlHandle);
    return context.newString(JSON.stringify({ url, status: 200, body: "probe-ok" }));
  });
  context.setProp(context.global, "req", reqHandle);
  reqHandle.dispose();

  try {
    const code = `
      import * as spiderModule from './spider.js';
      const spider = spiderModule.__jsEvalReturn
        ? spiderModule.__jsEvalReturn()
        : (typeof spiderModule.default === 'function'
          ? spiderModule.default()
          : spiderModule.default);
      spider.init({ source: 'local-fixture' });
      export const probe = {
        home: spider.home(),
        search: spider.search('QX', true),
        player: spider.player('default', 'episode-1'),
      };
      export default spider;
    `;
    const result = context.unwrapResult(context.evalCode(code, "probe.mjs", { type: "module" }));
    try {
      return {
        probe: "quickjs",
        passed: true,
        exports: context.dump(result),
      };
    } finally {
      result.dispose();
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

if (isMain()) {
  runJsProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}

function isMain(): boolean {
  return process.argv[1]?.endsWith("js-probe.ts") ?? false;
}
