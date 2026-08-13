import { existsSync } from "node:fs";

import {
  type AndroidDeviceManagerPort,
  type AndroidEnvironmentSnapshot,
} from "./android-device-manager.js";
import { AndroidSpiderBridgeClient } from "./android-spider-bridge-client.js";
import type { AndroidRuntimeBootstrapState, AndroidRuntimeMode, AndroidRuntimeProgress, AndroidRuntimeSupervisorState, WhpxStatus } from "./android-runtime-types.js";

export interface AndroidRuntimeStatus {
  adbFound: boolean;
  adbPath?: string;
  deviceFound: boolean;
  deviceSerial?: string;
  deviceStatus: "online" | "offline" | "missing";
  hostApkFound: boolean;
  hostApkPath: string;
  hostInstalled: boolean;
  hostStatus: "online" | "offline" | "missing";
  androidHostOnline: boolean;
  diagnostics: readonly string[];
  message: string;
  bootstrapState?: AndroidRuntimeBootstrapState;
  supervisorState?: AndroidRuntimeSupervisorState;
  consentRequired?: boolean;
  runtimeVersion?: string;
  hostVersion?: string;
  androidApi?: number;
  architecture?: string;
  avdName?: string;
  estimatedDownload?: string;
  diskUsageBytes?: number;
  mode?: AndroidRuntimeMode;
  whpx?: WhpxStatus;
  progress?: AndroidRuntimeProgress;
  runtimeRoot?: string;
  sdkRoot?: string;
  emulatorPath?: string;
  avdHome?: string;
  androidUserHome?: string;
}

export interface AndroidRuntimeDiagnosticsOptions {
  deviceManager: AndroidDeviceManagerPort & { check(): Promise<AndroidEnvironmentSnapshot>; isHostInstalled(): Promise<boolean> };
  hostApkPath: string;
  probeHost?: (deviceManager: AndroidRuntimeDiagnosticsOptions["deviceManager"]) => Promise<boolean>;
}

/** Non-fatal startup health check for the optional Android Spider runtime. */
export class AndroidRuntimeDiagnostics {
  private readonly deviceManager: AndroidRuntimeDiagnosticsOptions["deviceManager"];
  private readonly hostApkPath: string;
  private readonly probeHost: NonNullable<AndroidRuntimeDiagnosticsOptions["probeHost"]>;
  private current: AndroidRuntimeStatus;
  private refreshPromise: Promise<AndroidRuntimeStatus> | undefined;

  public constructor(options: AndroidRuntimeDiagnosticsOptions) {
    this.deviceManager = options.deviceManager;
    this.hostApkPath = options.hostApkPath;
    this.probeHost = options.probeHost ?? defaultProbeHost;
    this.current = offlineStatus(this.hostApkPath, ["ANDROID_RUNTIME_NOT_CHECKED"]);
  }

  public status(): AndroidRuntimeStatus {
    return { ...this.current, diagnostics: [...this.current.diagnostics] };
  }

  public async refresh(): Promise<AndroidRuntimeStatus> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshOnce().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  public async ensureHostOnline(): Promise<AndroidRuntimeStatus> {
    const status = await this.refresh();
    if (!status.androidHostOnline) {
      throw new Error(`ANDROID_HOST_OFFLINE: ${status.message}`);
    }
    return status;
  }

  private async refreshOnce(): Promise<AndroidRuntimeStatus> {
    const hostApkFound = existsSync(this.hostApkPath);
    let environment: AndroidEnvironmentSnapshot;
    try {
      environment = await this.deviceManager.check();
    } catch (error) {
      this.current = offlineStatus(this.hostApkPath, ["ANDROID_RUNTIME_CHECK_FAILED"], errorMessage(error));
      return this.status();
    }

    const diagnostics = [...environment.diagnostics];
    let hostInstalled = false;
    let hostOnline = false;
    if (environment.deviceFound) {
      hostInstalled = await this.deviceManager.isHostInstalled();
      if (!hostInstalled && hostApkFound) {
        try {
          await this.deviceManager.install(this.hostApkPath);
          hostInstalled = true;
        } catch (error) {
          diagnostics.push("ANDROID_HOST_INSTALL_FAILED", errorCode(error));
        }
      }
      if (hostInstalled) {
        try {
          hostOnline = await this.probeHost(this.deviceManager);
        } catch (error) {
          diagnostics.push("ANDROID_HOST_OFFLINE", errorCode(error));
        }
      }
    }
    if (!hostApkFound) diagnostics.push("HOST_APK_NOT_FOUND");
    if (environment.deviceFound && !hostInstalled) diagnostics.push("HOST_NOT_INSTALLED");
    if (hostInstalled && !hostOnline) diagnostics.push("HOST_OFFLINE");

    this.current = {
      adbFound: environment.adbFound,
      ...(environment.adbPath ? { adbPath: environment.adbPath } : {}),
      deviceFound: environment.deviceFound,
      ...(environment.device?.serial ? { deviceSerial: environment.device.serial } : {}),
      deviceStatus: environment.deviceFound ? "online" : "missing",
      hostApkFound,
      hostApkPath: this.hostApkPath,
      hostInstalled,
      hostStatus: hostOnline ? "online" : hostInstalled ? "offline" : "missing",
      androidHostOnline: hostOnline,
      diagnostics: [...new Set(diagnostics)],
      message: hostOnline
        ? "Android Spider Runtime 已连接"
        : "Android Spider Runtime 未连接",
    };
    return this.status();
  }
}

async function defaultProbeHost(deviceManager: AndroidRuntimeDiagnosticsOptions["deviceManager"]): Promise<boolean> {
  await deviceManager.startHost();
  const client = new AndroidSpiderBridgeClient({ deviceManager });
  try {
    await client.connect();
    return true;
  } finally {
    await client.close();
  }
}

function offlineStatus(hostApkPath: string, diagnostics: readonly string[], message = "Android Spider Runtime 未连接"): AndroidRuntimeStatus {
  return {
    adbFound: false,
    deviceFound: false,
    deviceStatus: "missing",
    hostApkFound: existsSync(hostApkPath),
    hostApkPath,
    hostInstalled: false,
    hostStatus: "missing",
    androidHostOnline: false,
    diagnostics,
    message,
  };
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "ANDROID_RUNTIME_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
