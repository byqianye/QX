import type { TvBoxSite } from "../config/decoder.js";

export interface SpiderCredentialStatus {
  provider: "uc";
  configured: boolean;
}

export interface SpiderCredentialProvider {
  get(site: TvBoxSite): Promise<string | undefined>;
  status(site: TvBoxSite): Promise<SpiderCredentialStatus>;
}

export class MemorySpiderCredentialProvider implements SpiderCredentialProvider {
  private token: string | undefined;

  public constructor(token?: string) {
    this.token = token?.trim() || undefined;
  }

  public setAccessToken(token: string | undefined): void {
    this.token = token?.trim() || undefined;
  }

  public async get(_site: TvBoxSite): Promise<string | undefined> {
    return this.token;
  }

  public async status(_site: TvBoxSite): Promise<SpiderCredentialStatus> {
    return { provider: "uc", configured: Boolean(this.token) };
  }
}

export function ucCredentialPayload(accessToken: string): string {
  const token = accessToken.trim();
  if (!token) throw new Error("UC access_token is required");
  return JSON.stringify({ access_token: token });
}

export function isCredentialSite(site: TvBoxSite): boolean {
  return /^csp_/iu.test(site.api?.trim() ?? "") && /duopan|wangpan/iu.test(site.api?.trim() ?? "");
}
