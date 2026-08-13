import type { AndroidDeviceManagerPort, AndroidEnvironmentSnapshot } from "./android-device-manager.js";

export const ANDROID_RUNTIME_AVD_NAME = "QXSpiderRuntime";
export const ANDROID_RUNTIME_SERIAL = "emulator-5554";
export const ANDROID_RUNTIME_ADB_SERVER_PORT = 5038;
export const ANDROID_RUNTIME_VERSION = "1.0.0";
export const ANDROID_RUNTIME_API = 35;
export const ANDROID_RUNTIME_ARCHITECTURE = "x86_64" as const;
export const ANDROID_RUNTIME_SYSTEM_IMAGE = `system-images;android-${ANDROID_RUNTIME_API};google_apis;${ANDROID_RUNTIME_ARCHITECTURE}`;
export const ANDROID_RUNTIME_ESTIMATED_DOWNLOAD = "约 2–3 GB";
export const ANDROID_RUNTIME_MIN_FREE_BYTES = 3.5 * 1024 * 1024 * 1024;

export type AndroidRuntimeBootstrapState =
  | "NOT_INSTALLED"
  | "CHECKING"
  | "DOWNLOADING"
  | "INSTALLING"
  | "CREATING_AVD"
  | "INSTALLING_HOST"
  | "STARTING"
  | "VERIFYING"
  | "READY"
  | "ERROR"
  | "REPAIR_AVAILABLE";

export type AndroidRuntimeSupervisorState =
  | "STOPPED"
  | "STARTING"
  | "BOOTING"
  | "INSTALLING_HOST"
  | "CONNECTING"
  | "READY"
  | "DEGRADED"
  | "CRASHED"
  | "STOPPING";

export type AndroidRuntimeMode = "auto" | "resident" | "disabled";
export type WhpxStatus = "ready" | "missing" | "unknown";

export type AndroidRuntimeProgressStage =
  | "idle"
  | "preparing"
  | "downloading"
  | "validating"
  | "installing"
  | "creating-avd"
  | "starting"
  | "installing-host"
  | "verifying"
  | "ready"
  | "error";

export interface AndroidRuntimeProgress {
  stage: AndroidRuntimeProgressStage;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  remainingSeconds?: number;
  message?: string;
  cancellable: boolean;
}

export interface AndroidRuntimePaths {
  root: string;
  sdk: string;
  avd: string;
  downloads: string;
  host: string;
  state: string;
  runtimeRoot?: string;
  sdkRoot?: string;
  adbPath?: string;
  emulatorPath?: string;
  avdHome?: string;
  androidUserHome?: string;
  hostApkPath?: string;
  runtimeStatePath?: string;
  spiderCachePath?: string;
}

export interface AndroidRuntimeManifest {
  schemaVersion: 1;
  runtimeVersion: string;
  minimumQxVersion: string;
  android: {
    api: number;
    architecture: typeof ANDROID_RUNTIME_ARCHITECTURE;
    image: typeof ANDROID_RUNTIME_SYSTEM_IMAGE;
    avdName: typeof ANDROID_RUNTIME_AVD_NAME;
  };
  sdkPackages: readonly string[];
  sdkComponents: {
    platformTools: AndroidRuntimeComponentLock;
    emulator: AndroidRuntimeComponentLock;
    platform: AndroidRuntimeComponentLock;
    systemImage: AndroidRuntimeComponentLock;
  };
  commandLineTools: {
    version: string;
    url: string;
    sha256: string;
  };
  host: {
    version: string;
    sha256: string;
  };
}

export interface AndroidRuntimeComponentLock {
  packageId: string;
  version: string;
  relativePath: string;
  sha256: string;
}

export interface AndroidRuntimePersistedState {
  bootstrapState: AndroidRuntimeBootstrapState;
  runtimeVersion: string;
  updatedAt: string;
  diagnostics: readonly string[];
  progress?: AndroidRuntimeProgress;
}

export interface AndroidEnvironmentDoctorResult {
  emulatorFound: boolean;
  emulatorPath?: string;
  whpx: WhpxStatus;
  diagnostics: readonly string[];
  message: string;
}

export interface AndroidRuntimeStatus {
  bootstrapState: AndroidRuntimeBootstrapState;
  supervisorState: AndroidRuntimeSupervisorState;
  consentRequired: boolean;
  runtimeVersion: string;
  hostVersion?: string;
  androidApi: number;
  architecture: typeof ANDROID_RUNTIME_ARCHITECTURE;
  avdName: typeof ANDROID_RUNTIME_AVD_NAME;
  estimatedDownload: string;
  diskUsageBytes?: number;
  mode: AndroidRuntimeMode;
  whpx: WhpxStatus;
  adbFound: boolean;
  deviceFound: boolean;
  deviceSerial?: string;
  hostInstalled: boolean;
  hostOnline: boolean;
  diagnostics: readonly string[];
  message: string;
  progress: AndroidRuntimeProgress;
  runtimeRoot?: string;
  sdkRoot?: string;
  adbPath?: string;
  emulatorPath?: string;
  avdHome?: string;
  androidUserHome?: string;
}

export interface AndroidManagedDevice extends AndroidDeviceManagerPort {
  check(): Promise<AndroidEnvironmentSnapshot>;
  isHostInstalled(): Promise<boolean>;
  waitForBoot(): Promise<NonNullable<AndroidEnvironmentSnapshot["device"]>>;
}
