import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("G72 Windows installer configuration", () => {
  it("defines a per-user NSIS installer without file associations", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      build?: {
        productName?: string;
        win?: { target?: Array<{ target?: string; arch?: string[] }> };
        nsis?: Record<string, unknown>;
        fileAssociations?: unknown;
      };
    };
    expect(packageJson.build?.productName).toBe("QX影视");
    expect(packageJson.build?.win?.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(packageJson.build?.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      deleteAppDataOnUninstall: false,
    });
    expect(packageJson.build?.fileAssociations).toBeUndefined();
  });

  it("keeps user data by default and exposes an explicit uninstall component", () => {
    const script = readFileSync(new URL("../build/installer.nsh", import.meta.url), "utf8");
    expect(script).toContain("customUnInstallSection");
    expect(script).toContain("Section /o");
    expect(script).toContain("DELETE_QX_USER_DATA");
    expect(script).toContain("$APPDATA\\QX影视");
  });
});
