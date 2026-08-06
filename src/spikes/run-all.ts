import { runConfigProbe } from "./config-probe.js";
import { runDoubanProbe } from "./douban-probe.js";
import { runJavaProbe } from "./java-probe.js";
import { runJvmProbe } from "./jvm-probe.js";
import { runJsProbe } from "./js-probe.js";
import { runPythonProbe } from "./python-probe.js";

const results = await Promise.all([
  runConfigProbe(),
  runJsProbe(),
  runPythonProbe(),
  runJavaProbe(),
  runJvmProbe(),
  runDoubanProbe(),
]);

console.log(JSON.stringify(results, null, 2));
