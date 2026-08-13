import { safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { TvBoxSite } from "../config/decoder.js";
import { isCredentialSite, type SpiderCredentialProvider, type SpiderCredentialStatus } from "./spider-credential-provider.js";

/** Stores the explicit user token as Electron safeStorage ciphertext, never as JSON/settings text. */
export class ElectronSpiderCredentialProvider implements SpiderCredentialProvider {
  public constructor(private readonly path: string) {}

  public async get(site: TvBoxSite): Promise<string | undefined> {
    if (!isCredentialSite(site)) return undefined;
    const encrypted = this.readEncrypted();
    if (!encrypted || !safeStorage.isEncryptionAvailable()) return undefined;
    try {
      const token = safeStorage.decryptString(Buffer.from(encrypted, "base64")).trim();
      return token || undefined;
    } catch {
      return undefined;
    }
  }

  public async status(site?: TvBoxSite): Promise<SpiderCredentialStatus> {
    if (site && !isCredentialSite(site)) return { provider: "uc", configured: false };
    return {
      provider: "uc",
      configured: Boolean(this.readEncrypted() && safeStorage.isEncryptionAvailable()),
    };
  }

  public setAccessToken(token: string): void {
    const value = token.trim();
    if (!value) throw new Error("UC access_token is required");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage is unavailable");
    const encrypted = safeStorage.encryptString(value).toString("base64");
    writeFileSync(this.path, encrypted, { encoding: "utf8", mode: 0o600 });
  }

  public clear(): void {
    if (existsSync(this.path)) writeFileSync(this.path, "", { encoding: "utf8", mode: 0o600 });
  }

  private readEncrypted(): string | undefined {
    try {
      const value = readFileSync(this.path, "utf8").trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }
}
