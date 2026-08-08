import type { TvBoxSite } from "../config/decoder.js";
import type { SpiderRuntime } from "./runtime-types.js";

export interface NativeSpiderRegistration {
  api: string;
  factory: (site: TvBoxSite) => SpiderRuntime | undefined;
}

export class NativeSpiderRegistry {
  private readonly entries = new Map<string, NativeSpiderRegistration>();

  public register(registration: NativeSpiderRegistration): void {
    const api = registration.api.trim().toLowerCase();
    if (!api) throw new Error("Native Spider API is required");
    this.entries.set(api, { ...registration, api: registration.api.trim() });
  }

  public has(api: string | undefined): boolean {
    return typeof api === "string" && this.entries.has(api.trim().toLowerCase());
  }

  public get(api: string | undefined): NativeSpiderRegistration | undefined {
    if (typeof api !== "string") return undefined;
    const registration = this.entries.get(api.trim().toLowerCase());
    return registration ? { ...registration } : undefined;
  }

  public list(): readonly NativeSpiderRegistration[] {
    return [...this.entries.values()].map((registration) => ({ ...registration }));
  }

  public create(site: TvBoxSite): SpiderRuntime | undefined {
    return this.get(site.api)?.factory(site);
  }
}
