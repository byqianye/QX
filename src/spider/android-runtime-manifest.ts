import type { AndroidRuntimeComponentLock, AndroidRuntimeManifest } from "./android-runtime-types.js";
import {
  ANDROID_RUNTIME_API,
  ANDROID_RUNTIME_ARCHITECTURE,
  ANDROID_RUNTIME_AVD_NAME,
  ANDROID_RUNTIME_SYSTEM_IMAGE,
  ANDROID_RUNTIME_VERSION,
} from "./android-runtime-types.js";

export const ANDROID_COMMAND_LINE_TOOLS = {
  version: "15859902",
  url: "https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip",
  sha256: "90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a",
} as const;

export const ANDROID_RUNTIME_MINIMUM_QX_VERSION = "0.9.0-rc.1";

export { ANDROID_RUNTIME_VERSION } from "./android-runtime-types.js";
export const ANDROID_RUNTIME_SDK_PACKAGES = [
  "platform-tools",
  "emulator",
  `platforms;android-${ANDROID_RUNTIME_API}`,
  ANDROID_RUNTIME_SYSTEM_IMAGE,
] as const;

// These locks were recorded from the official packages used by the G103
// Windows x64 runtime. The SHA256 values cover each installed package tree
// using sorted relative paths and file contents.
export const ANDROID_RUNTIME_SDK_COMPONENT_LOCKS = {
  platformTools: {
    packageId: "platform-tools",
    version: "37.0.1",
    relativePath: "platform-tools",
    sha256: "F7B668DE557A79BBA6A75725C1778E99B0D6D3A657726EA8BF7D0A7150F38949",
  },
  emulator: {
    packageId: "emulator",
    version: "37.1.11",
    relativePath: "emulator",
    sha256: "F4AD8BC8D5B4D3F87ACEBFC9C0FBDB63977DADCA9945CBA9B2162C6EB608BFCD",
  },
  platform: {
    packageId: `platforms;android-${ANDROID_RUNTIME_API}`,
    version: "2",
    relativePath: `platforms/android-${ANDROID_RUNTIME_API}`,
    sha256: "F7C734FF1BB398863254444C41C9C696CB6AFEA19EE74E91229B18B065DFE049",
  },
  systemImage: {
    packageId: ANDROID_RUNTIME_SYSTEM_IMAGE,
    version: "9",
    relativePath: `system-images/android-${ANDROID_RUNTIME_API}/google_apis/${ANDROID_RUNTIME_ARCHITECTURE}`,
    sha256: "2471E4233554620BF5FE970B7C1BE6A14540FF5FCE872F7F6ED051F82DD6FBCF",
  },
} as const satisfies Record<string, AndroidRuntimeComponentLock>;

export function buildAndroidRuntimeManifest(hostSha256: string, hostVersion = "1.0.0"): AndroidRuntimeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: ANDROID_RUNTIME_VERSION,
    minimumQxVersion: ANDROID_RUNTIME_MINIMUM_QX_VERSION,
    android: {
      api: ANDROID_RUNTIME_API,
      architecture: ANDROID_RUNTIME_ARCHITECTURE,
      image: ANDROID_RUNTIME_SYSTEM_IMAGE,
      avdName: ANDROID_RUNTIME_AVD_NAME,
    },
    sdkPackages: [...ANDROID_RUNTIME_SDK_PACKAGES],
    sdkComponents: {
      platformTools: { ...ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.platformTools },
      emulator: { ...ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.emulator },
      platform: { ...ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.platform },
      systemImage: { ...ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.systemImage },
    },
    commandLineTools: { ...ANDROID_COMMAND_LINE_TOOLS },
    host: { version: hostVersion, sha256: hostSha256 },
  };
}

export function isAndroidRuntimeManifest(value: unknown): value is AndroidRuntimeManifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const android = record.android;
  const components = record.sdkComponents;
  const tools = record.commandLineTools;
  const host = record.host;
  return record.schemaVersion === 1
    && typeof record.runtimeVersion === "string"
    && typeof record.minimumQxVersion === "string"
    && typeof android === "object" && android !== null
    && (android as Record<string, unknown>).api === ANDROID_RUNTIME_API
    && (android as Record<string, unknown>).architecture === ANDROID_RUNTIME_ARCHITECTURE
    && (android as Record<string, unknown>).image === ANDROID_RUNTIME_SYSTEM_IMAGE
    && (android as Record<string, unknown>).avdName === ANDROID_RUNTIME_AVD_NAME
    && Array.isArray(record.sdkPackages)
    && (record.sdkPackages as unknown[]).every((item) => typeof item === "string")
    && (record.sdkPackages as string[]).includes("platform-tools")
    && (record.sdkPackages as string[]).includes("emulator")
    && isComponentLock(components, "platformTools", ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.platformTools)
    && isComponentLock(components, "emulator", ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.emulator)
    && isComponentLock(components, "platform", ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.platform)
    && isComponentLock(components, "systemImage", ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.systemImage)
    && typeof tools === "object" && tools !== null
    && typeof (tools as Record<string, unknown>).version === "string"
    && typeof (tools as Record<string, unknown>).url === "string"
    && typeof (tools as Record<string, unknown>).sha256 === "string"
    && /^[a-f0-9]{64}$/iu.test((tools as Record<string, unknown>).sha256 as string)
    && typeof host === "object" && host !== null
    && typeof (host as Record<string, unknown>).version === "string"
    && typeof (host as Record<string, unknown>).sha256 === "string"
    && /^[a-f0-9]{64}$/iu.test((host as Record<string, unknown>).sha256 as string);
}

function isComponentLock(
  value: unknown,
  key: string,
  expected: AndroidRuntimeComponentLock,
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const lock = (value as Record<string, unknown>)[key];
  if (typeof lock !== "object" || lock === null) return false;
  const record = lock as Record<string, unknown>;
  return record.packageId === expected.packageId
    && record.version === expected.version
    && record.relativePath === expected.relativePath
    && typeof record.sha256 === "string"
    && /^[a-f0-9]{64}$/iu.test(record.sha256 as string)
    && String(record.sha256).toUpperCase() === expected.sha256;
}
