import { spawnSync } from "node:child_process";

import type { TvBoxConfig, TvBoxSite } from "../config/decoder.js";

export interface PythonInspectorOptions {
  available?: boolean | (() => boolean | Promise<boolean>);
}

export interface PythonInspection {
  isPython: boolean;
  available: boolean;
  reference?: string;
}

export class PythonInspector {
  private readonly available: boolean | (() => boolean | Promise<boolean>);

  public constructor(options: PythonInspectorOptions = {}) {
    this.available = options.available ?? defaultPythonAvailable;
  }

  public async inspect(site: TvBoxSite, config?: TvBoxConfig): Promise<PythonInspection> {
    const reference = references(site, config).find((value) => (
      /^py:/i.test(value) || /\.py(?:$|[?#])/i.test(value)
    ));
    if (!reference) return { isPython: false, available: false };
    const available = typeof this.available === "function" ? await this.available() : this.available;
    return { isPython: true, available, reference };
  }
}

function defaultPythonAvailable(): boolean {
  const executable = process.env.QX_PYTHON?.trim() || "python";
  return spawnSync(executable, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;
}

function references(site: TvBoxSite, config?: TvBoxConfig): string[] {
  return [site.api, site.ext, site.script, site.spider, config?.spider]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}
