import { describe, expect, it } from "vitest";

import { parseAndroidDeviceProperties, selectAndroidDevice, type AndroidDevice } from "../src/spider/android-device-manager.js";

describe("Android device selection and diagnostics", () => {
  const physical = (serial: string): AndroidDevice => ({ serial, state: "device" });

  it("prefers an online emulator when no serial is configured", () => {
    expect(selectAndroidDevice([physical("usb-1"), physical("emulator-5554")], undefined)?.serial).toBe("emulator-5554");
  });

  it("does not guess between multiple physical devices", () => {
    expect(selectAndroidDevice([physical("usb-1"), physical("usb-2")], undefined)).toBeUndefined();
    expect(selectAndroidDevice([physical("usb-1"), physical("usb-2")], "usb-2")?.serial).toBe("usb-2");
  });

  it("records Android properties required by the Environment Doctor", () => {
    expect(parseAndroidDeviceProperties([
      "[ro.product.model]: [Pixel_7]",
      "[ro.build.version.release]: [14]",
      "[ro.build.version.sdk]: [34]",
      "[ro.product.cpu.abilist]: [x86_64,x86]",
      "[sys.boot_completed]: [1]",
    ].join("\n"))).toEqual({
      model: "Pixel_7",
      androidVersion: "14",
      sdkInt: 34,
      abi: "x86_64",
      bootCompleted: true,
    });
  });
});
