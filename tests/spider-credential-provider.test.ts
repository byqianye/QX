import { describe, expect, it } from "vitest";

import { MemorySpiderCredentialProvider, ucCredentialPayload } from "../src/spider/spider-credential-provider.js";

describe("Spider credentials", () => {
  it("reports missing and configured UC credentials without exposing the token", async () => {
    const provider = new MemorySpiderCredentialProvider();
    const site = { type: 3, api: "csp_Duopan" };

    await expect(provider.status(site)).resolves.toEqual({ provider: "uc", configured: false });
    provider.setAccessToken("test-uc-token");
    await expect(provider.status(site)).resolves.toEqual({ provider: "uc", configured: true });
    await expect(provider.get(site)).resolves.toBe("test-uc-token");
    expect(ucCredentialPayload("test-uc-token")).toBe(JSON.stringify({ access_token: "test-uc-token" }));
  });
});
