import { describe, expect, it } from "vitest";

import { selectAndroidPocSite } from "../src/spikes/android-spider-poc.js";

describe("Android Spider PoC site selection", () => {
  const sites = [
    { key: "feimao", name: "FeiMao", api: "csp_FeiMaoUC", type: 3 },
    { key: "荐片", name: "荐片影视", api: "csp_Jianpian", type: 3 },
  ];

  it("selects the requested API instead of silently using the first source", () => {
    expect(selectAndroidPocSite(sites, "csp_Jianpian")).toMatchObject({ key: "荐片", api: "csp_Jianpian" });
    expect(selectAndroidPocSite(sites)).toMatchObject({ key: "feimao", api: "csp_FeiMaoUC" });
  });

  it("fails clearly when the requested source is absent", () => {
    expect(() => selectAndroidPocSite(sites, "csp_Missing")).toThrow("ANDROID_POC_SITE_NOT_FOUND");
  });
});
