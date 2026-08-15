import { mkdtempSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { getServers } from "node:dns";
import { isIP } from "node:net";
import { join } from "node:path";

import { AndroidDeviceManager, type AndroidDeviceManagerOptions } from "./android-device-manager.js";
import { AndroidEnvironmentDoctor } from "./android-environment-doctor.js";
import { AndroidSpiderBridgeClient } from "./android-spider-bridge-client.js";
import { AndroidRuntimeBootstrapper } from "./android-runtime-bootstrapper.js";
import type { AndroidRuntimeCommandRunner, AndroidRuntimeRunningProcess } from "./android-runtime-process.js";
import { NodeAndroidRuntimeCommandRunner } from "./android-runtime-process.js";
import type {
  AndroidManagedDevice,
  AndroidRuntimeStatus,
  AndroidRuntimeSupervisorState,
  AndroidRuntimePaths,
  AndroidRuntimeMode,
  AndroidRuntimeProgress,
  AndroidRuntimeAvdName,
} from "./android-runtime-types.js";
import {
  ANDROID_RUNTIME_API,
  ANDROID_RUNTIME_ARCHITECTURE,
  ANDROID_RUNTIME_AVD_NAME,
  ANDROID_RUNTIME_COMPACT_AVD_NAME,
  ANDROID_RUNTIME_ESTIMATED_DOWNLOAD,
  ANDROID_RUNTIME_SERIAL,
  ANDROID_RUNTIME_VERSION,
} from "./android-runtime-types.js";

interface SupervisorBridge {
  connect(): Promise<Record<string, unknown>>;
  health(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

const DEFAULT_ANDROID_RUNTIME_IDLE_SHUTDOWN_MS = 20 * 60 * 1_000;

export interface AndroidRuntimeSupervisorOptions {
  paths: AndroidRuntimePaths;
  bootstrapper: AndroidRuntimeBootstrapper;
  commandRunner?: AndroidRuntimeCommandRunner;
  hostPackage?: string;
  hostActivity?: string;
  deviceManagerFactory?: (options: AndroidDeviceManagerOptions) => AndroidManagedDevice;
  bridgeFactory?: (deviceManager: AndroidManagedDevice) => SupervisorBridge;
  now?: () => Date;
  diagnosticLogger?: (event: string, details: Record<string, unknown>) => void;
  avdName?: AndroidRuntimeAvdName;
  idleShutdownMs?: number;
}

export function buildAndroidEmulatorArguments(
  dnsServers: readonly string[],
  avdName: AndroidRuntimeAvdName = ANDROID_RUNTIME_AVD_NAME,
  userdataImagePath?: string,
): string[] {
  const args = [
    "-avd", avdName,
    "-port", "5554",
    "-no-window",
    "-no-audio",
    "-no-boot-anim",
    "-no-snapshot",
    "-no-snapstorage",
    // Force the software backend for headless Windows runs. Leaving the
    // emulator's GPU mode at auto can exit before the first boot on a clean
    // profile even though WHPX itself is available.
    "-gpu", "swiftshader_indirect",
  ];
  if (avdName === ANDROID_RUNTIME_COMPACT_AVD_NAME) {
    args.push("-partition-size", "1024");
    if (userdataImagePath) args.push("-data", userdataImagePath);
  }
  const usableDnsServers = dnsServers
    .map((server) => server.trim())
    .filter((server) => isIP(server) > 0);
  if (usableDnsServers.length > 0) args.push("-dns-server", usableDnsServers.join(","));
  return args;
}

export interface AndroidRuntimeEnsureOptions {
  consent?: boolean;
}

export class AndroidRuntimeSupervisor {
  private readonly options: Required<Pick<AndroidRuntimeSupervisorOptions, "commandRunner" | "now">> & AndroidRuntimeSupervisorOptions;
  private current: AndroidRuntimeStatus;
  private deviceManagerValue: AndroidManagedDevice | undefined;
  private emulatorProcess: AndroidRuntimeRunningProcess | undefined;
  private bridge: SupervisorBridge | undefined;
  private operation: Promise<AndroidRuntimeStatus> | undefined;
  private recoveryUsed = false;
  private crashRecoveryPromise: Promise<void> | undefined;
  private idleShutdownTimer: NodeJS.Timeout | undefined;
  private mode: AndroidRuntimeMode = "auto";
  private readonly modePath: string;

  public constructor(options: AndroidRuntimeSupervisorOptions) {
    this.options = {
      commandRunner: new NodeAndroidRuntimeCommandRunner(),
      now: () => new Date(),
      ...options,
    };
    this.current = initialStatus(this.options.avdName ?? ANDROID_RUNTIME_AVD_NAME);
    this.modePath = join(options.paths.state, "runtime-mode.json");
  }

  public status(): AndroidRuntimeStatus {
    return {
      ...this.current,
      ...(this.current.deviceSerial ? { deviceSerial: this.current.deviceSerial } : {}),
      diagnostics: [...this.current.diagnostics],
    };
  }

  public updateProgress(progress: AndroidRuntimeProgress): void {
    this.current = { ...this.current, progress };
  }

  public get deviceManager(): AndroidManagedDevice {
    if (!this.deviceManagerValue) throw new Error("ANDROID_RUNTIME_NOT_READY");
    return this.deviceManagerValue;
  }

  public async ensureReady(options: AndroidRuntimeEnsureOptions = {}): Promise<AndroidRuntimeStatus> {
    if (this.operation) return this.operation;
    if (this.current.supervisorState === "READY" && this.bridge) {
      try {
        await this.bridge.health();
        this.markActivity();
        return this.status();
      } catch {
        // Fall through to the bounded recovery path.
      }
    }
    this.operation = this.ensureReadyOnce(options).finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  public async restart(): Promise<AndroidRuntimeStatus> {
    await this.stopRuntime();
    return this.ensureReady({ consent: true });
  }

  public async setMode(mode: AndroidRuntimeMode): Promise<AndroidRuntimeStatus> {
    this.mode = mode;
    await mkdir(this.options.paths.state, { recursive: true });
    await writeFile(this.modePath, `${JSON.stringify({ mode })}\n`, "utf8");
    this.current = { ...this.current, mode };
    if (mode === "disabled") await this.stopRuntime();
    else if (mode === "resident") this.clearIdleShutdown();
    else this.markActivity();
    return this.status();
  }

  public async enableWhpx(confirmed: boolean): Promise<AndroidRuntimeStatus> {
    const doctor = new AndroidEnvironmentDoctor({
      emulatorPath: this.options.bootstrapper.emulatorPath(),
      commandRunner: this.options.commandRunner,
      env: this.options.bootstrapper.commandEnvironment(),
    });
    await doctor.enableWhpx(confirmed);
    this.current = { ...this.current, message: "WHPX 已请求启用；Windows 可能需要重启后再启动 Android Runtime" };
    return this.status();
  }

  public async refresh(): Promise<AndroidRuntimeStatus> {
    const state = await this.options.bootstrapper.status();
    try {
      const value = JSON.parse(await readFile(this.modePath, "utf8")) as { mode?: unknown };
      if (value.mode === "auto" || value.mode === "resident" || value.mode === "disabled") this.mode = value.mode;
    } catch {
      // Auto is the default and does not require a state file.
    }
    this.current = {
      ...this.current,
      mode: this.mode,
      bootstrapState: state.bootstrapState,
      progress: state.progress ?? this.current.progress,
      consentRequired: state.bootstrapState === "NOT_INSTALLED" || state.diagnostics.includes("ANDROID_RUNTIME_CONSENT_REQUIRED"),
      diagnostics: [...state.diagnostics],
      message: state.bootstrapState === "READY" ? "Android 兼容运行环境已安装，可按需启动" : this.current.message,
    };
    if (state.bootstrapState === "READY") {
      const doctor = await this.options.bootstrapper.environmentDoctor();
      this.current = { ...this.current, whpx: doctor.whpx, diagnostics: [...new Set([...this.current.diagnostics, ...doctor.diagnostics])] };
    }
    await this.refreshRuntimeMetadata();
    return this.status();
  }

  public async repair(consent: boolean): Promise<AndroidRuntimeStatus> {
    await this.stopRuntime();
    await this.options.bootstrapper.repair(consent);
    this.current = { ...this.current, bootstrapState: "CHECKING", supervisorState: "STOPPED", diagnostics: [] };
    return this.ensureReady({ consent });
  }

  public async cancelProvision(): Promise<AndroidRuntimeStatus> {
    await this.options.bootstrapper.cancel();
    await this.stopRuntime();
    this.current = { ...this.current, bootstrapState: "REPAIR_AVAILABLE", supervisorState: "DEGRADED", message: "Android Runtime 安装已取消。" };
    return this.status();
  }

  public async reinstall(consent: boolean): Promise<AndroidRuntimeStatus> {
    await this.stopRuntime();
    await this.options.bootstrapper.uninstall();
    return this.ensureReady({ consent });
  }

  public async uninstall(): Promise<void> {
    await this.stopRuntime();
    await this.options.bootstrapper.uninstall();
    this.current = { ...initialStatus(this.options.avdName ?? ANDROID_RUNTIME_AVD_NAME), mode: this.mode, diagnostics: ["ANDROID_RUNTIME_UNINSTALLED"], message: "Android 兼容运行环境已卸载" };
  }

  public async stopRuntime(): Promise<void> {
    this.clearIdleShutdown();
    this.current = { ...this.current, supervisorState: "STOPPING", message: "正在停止 Android 兼容运行环境…" };
    await this.bridge?.close().catch(() => undefined);
    this.bridge = undefined;
    await this.deviceManagerValue?.stopHost().catch(() => undefined);
    await this.emulatorProcess?.stop().catch(() => undefined);
    this.emulatorProcess = undefined;
    this.deviceManagerValue = undefined;
    this.recoveryUsed = false;
    this.crashRecoveryPromise = undefined;
    this.current = { ...this.current, supervisorState: "STOPPED", hostOnline: false, deviceFound: false, hostInstalled: false, message: "Android 兼容运行环境已停止" };
  }

  /** Refreshes the auto-shutdown deadline after an Android runtime operation. */
  public touchActivity(): void {
    this.markActivity();
  }

  private async refreshRuntimeMetadata(): Promise<void> {
    const diskUsageBytes = await directorySize(this.options.paths.root);
    let hostVersion: string | undefined;
    try {
      hostVersion = (await this.options.bootstrapper.manifest()).host.version;
    } catch {
      // The source APK or persisted manifest may not exist before first use.
    }
    this.current = {
      ...this.current,
      diskUsageBytes,
      ...(hostVersion ? { hostVersion } : {}),
    };
  }

  private async ensureReadyOnce(options: AndroidRuntimeEnsureOptions): Promise<AndroidRuntimeStatus> {
    if (this.mode === "disabled") {
      this.current = { ...this.current, message: "Android 兼容运行环境已禁用" };
      throw new AndroidRuntimeSupervisorError("ANDROID_RUNTIME_DISABLED", this.current.message, this.status());
    }
    const provisioned = await this.options.bootstrapper.ensureProvisioned({ consent: options.consent === true });
    this.current = { ...this.current, bootstrapState: provisioned.bootstrapState, diagnostics: [...provisioned.diagnostics], progress: provisioned.progress ?? this.current.progress };
    if (provisioned.bootstrapState !== "READY") {
      if (provisioned.diagnostics.includes("WHPX_NOT_READY")) {
        const doctor = await this.options.bootstrapper.environmentDoctor();
        this.current = { ...this.current, whpx: doctor.whpx, diagnostics: [...new Set([...this.current.diagnostics, ...doctor.diagnostics])] };
      }
      this.current = {
        ...this.current,
        supervisorState: "DEGRADED",
        consentRequired: provisioned.diagnostics.includes("ANDROID_RUNTIME_CONSENT_REQUIRED"),
        message: provisioned.diagnostics.includes("WHPX_NOT_READY")
          ? "Android 兼容运行环境需要启用 Windows Hypervisor Platform"
          : provisioned.diagnostics.includes("ANDROID_RUNTIME_CONSENT_REQUIRED")
            ? "需要确认 Android Runtime 下载和许可协议"
            : "Android 兼容运行环境尚未就绪",
      };
      throw new AndroidRuntimeSupervisorError("ANDROID_RUNTIME_NOT_READY", this.current.message, this.status());
    }
    await this.refreshRuntimeMetadata();
    this.current = { ...this.current, consentRequired: false, supervisorState: "STARTING", message: "正在启动 Android 兼容运行环境…" };
    const doctor = await this.options.bootstrapper.environmentDoctor();
    this.current = { ...this.current, whpx: doctor.whpx, diagnostics: [...doctor.diagnostics] };
    if (doctor.whpx !== "ready") {
      this.current = { ...this.current, supervisorState: "DEGRADED", message: doctor.message };
      throw new AndroidRuntimeSupervisorError("WHPX_NOT_READY", doctor.message, this.status());
    }

    try {
      await this.startAndVerify();
      return this.status();
    } catch (error) {
      const recovered = await this.recoverOnce();
      if (recovered) return this.status();
      await this.options.bootstrapper.recordState("REPAIR_AVAILABLE", [errorCode(error)]).catch(() => undefined);
      this.current = {
        ...this.current,
        bootstrapState: "REPAIR_AVAILABLE",
        supervisorState: "DEGRADED",
        message: error instanceof Error ? error.message : "Android 兼容运行环境异常",
        diagnostics: [...new Set([...this.current.diagnostics, errorCode(error)])],
      };
      throw new AndroidRuntimeSupervisorError("ANDROID_RUNTIME_DEGRADED", this.current.message, this.status(), error);
    }
  }

  private async startAndVerify(): Promise<void> {
    await this.options.bootstrapper.recordState("STARTING");
    await this.startEmulator();
    this.current = { ...this.current, supervisorState: "BOOTING", message: "正在启动隐藏 Android 模拟器…" };
    const deviceManager = this.ensureDeviceManager();
    this.options.diagnosticLogger?.("ANDROID_RUNTIME_BOOT_WAIT_START", {});
    const device = await deviceManager.waitForBoot();
    this.options.diagnosticLogger?.("ANDROID_RUNTIME_BOOT_READY", { serial: device.serial, bootCompleted: device.bootCompleted ?? null });
    this.current = { ...this.current, adbFound: true, deviceFound: true, deviceSerial: device.serial };
    if (typeof deviceManager.waitForNetwork === "function") {
      this.current = { ...this.current, message: "Waiting for Android network validation" };
      this.options.diagnosticLogger?.("ANDROID_RUNTIME_NETWORK_WAIT_START", {});
      await deviceManager.waitForNetwork();
      this.options.diagnosticLogger?.("ANDROID_RUNTIME_NETWORK_READY", {});
    }
    await this.options.bootstrapper.recordState("INSTALLING_HOST");
    this.current = { ...this.current, supervisorState: "INSTALLING_HOST", message: "正在安装 Android Spider Host…" };
    // Reinstall the verified managed APK on every runtime start so a Host update
    // is picked up without redownloading the Android SDK/system image.
    this.options.diagnosticLogger?.("ANDROID_RUNTIME_HOST_INSTALL_START", {});
    await this.deviceManager.install(this.options.bootstrapper.hostApkPath());
    this.options.diagnosticLogger?.("ANDROID_RUNTIME_HOST_INSTALL_READY", {});
    this.current = { ...this.current, hostInstalled: true, supervisorState: "CONNECTING", message: "正在连接 Android Host RPC…" };
    await this.deviceManager.startHost();
    this.options.diagnosticLogger?.("ANDROID_RUNTIME_HOST_START_READY", {});
    await this.connectBridge();
    this.options.diagnosticLogger?.("ANDROID_RUNTIME_HOST_RPC_CONNECTED", {});
    await this.options.bootstrapper.recordState("VERIFYING");
    this.current = { ...this.current, supervisorState: "CONNECTING", message: "正在验证 Android Host…" };
    await this.bridge?.health();
    await this.options.bootstrapper.recordState("READY");
    this.current = { ...this.current, supervisorState: "READY", hostOnline: true, message: "Android 兼容运行环境已就绪" };
    this.markActivity();
  }

  private async connectBridge(): Promise<void> {
    await this.bridge?.close().catch(() => undefined);
    const bridge = this.options.bridgeFactory?.(this.deviceManager)
      ?? new AndroidSpiderBridgeClient({
        deviceManager: this.deviceManager,
        localPort: 8765,
        remotePort: 8765,
        onActivity: () => this.markActivity(),
      });
    await bridge.connect();
    this.bridge = bridge;
  }

  private markActivity(): void {
    if (this.current.supervisorState !== "READY" || this.mode !== "auto") return;
    this.clearIdleShutdown();
    const idleShutdownMs = Math.max(0, Math.floor(this.options.idleShutdownMs ?? DEFAULT_ANDROID_RUNTIME_IDLE_SHUTDOWN_MS));
    if (idleShutdownMs === 0) return;
    this.idleShutdownTimer = setTimeout(() => {
      this.idleShutdownTimer = undefined;
      if (this.current.supervisorState !== "READY" || this.mode !== "auto") return;
      this.options.diagnosticLogger?.("ANDROID_RUNTIME_IDLE_SHUTDOWN", { idleShutdownMs });
      void this.stopRuntime();
    }, idleShutdownMs);
    this.idleShutdownTimer.unref?.();
  }

  private clearIdleShutdown(): void {
    if (!this.idleShutdownTimer) return;
    clearTimeout(this.idleShutdownTimer);
    this.idleShutdownTimer = undefined;
  }

  private async startEmulator(): Promise<void> {
    if (this.emulatorProcess?.isRunning()) return;
    const emulatorTemp = mkdtempSync(join(this.options.paths.state, "tmp", "emulator-"));
    const env: NodeJS.ProcessEnv = {
      ...this.options.bootstrapper.commandEnvironment(),
      TEMP: emulatorTemp,
      TMP: emulatorTemp,
    };
    const adbPath = env.ADB;
    if (adbPath) {
      const adbStop = await this.options.commandRunner.run(adbPath, ["kill-server"], {
        env,
        timeoutMs: 15_000,
      });
      this.options.diagnosticLogger?.("ANDROID_RUNTIME_ADB_RESET", {
        exitCode: adbStop.exitCode,
        stdout: adbStop.stdout,
        stderr: adbStop.stderr,
      });
      const adbServer = await this.options.commandRunner.run(adbPath, ["start-server"], {
        env,
        timeoutMs: 15_000,
      });
      this.options.diagnosticLogger?.("ANDROID_RUNTIME_ADB_START", {
        exitCode: adbServer.exitCode,
        stdout: adbServer.stdout,
        stderr: adbServer.stderr,
        adbPath,
        androidHome: env.ANDROID_HOME ?? null,
        androidSdkRoot: env.ANDROID_SDK_ROOT ?? null,
        androidAvdHome: env.ANDROID_AVD_HOME ?? null,
        androidUserHome: env.ANDROID_USER_HOME ?? null,
      });
      if (adbServer.exitCode !== 0) {
        throw new Error(`ANDROID_RUNTIME_ADB_SERVER_START_FAILED: ${adbServer.stderr || adbServer.stdout}`);
      }
    }
    this.emulatorProcess = this.options.commandRunner.start(
      this.options.bootstrapper.emulatorPath(),
      buildAndroidEmulatorArguments(
        getServers(),
        this.options.avdName ?? ANDROID_RUNTIME_AVD_NAME,
        this.options.bootstrapper.userdataImagePath(),
      ),
      { cwd: emulatorTemp, env },
    );
    this.options.diagnosticLogger?.("ANDROID_RUNTIME_EMULATOR_STARTED", {
      pid: this.emulatorProcess.pid ?? null,
      emulatorPath: this.options.bootstrapper.emulatorPath(),
      adbPath: adbPath ?? null,
      androidHome: env.ANDROID_HOME ?? null,
      androidSdkRoot: env.ANDROID_SDK_ROOT ?? null,
      androidAvdHome: env.ANDROID_AVD_HOME ?? null,
      androidUserHome: env.ANDROID_USER_HOME ?? null,
      adbServerPort: env.ANDROID_ADB_SERVER_PORT ?? null,
      tempPath: emulatorTemp,
    });
    const process = this.emulatorProcess;
    void process.exited.then((code) => {
      this.options.diagnosticLogger?.("ANDROID_RUNTIME_EMULATOR_EXITED", {
        code,
        ...(process.output ? process.output() : {}),
      });
      if (process.isRunning() === false
        && this.emulatorProcess === process
        && this.current.supervisorState !== "STOPPING"
        && code !== 0) {
        this.current = { ...this.current, supervisorState: "CRASHED", hostOnline: false, message: "Android 模拟器进程已退出" };
        this.crashRecoveryPromise ??= this.recoverAfterCrash(code).finally(() => {
          this.crashRecoveryPromise = undefined;
        });
      }
    });
  }

  private async recoverAfterCrash(code: number): Promise<void> {
    this.options.diagnosticLogger?.("ANDROID_RUNTIME_EMULATOR_RECOVERY_START", { code });
    try {
      await this.emulatorProcess?.stop().catch(() => undefined);
      this.emulatorProcess = undefined;
      this.deviceManagerValue = undefined;
      this.bridge = undefined;
      if (await this.recoverOnce()) {
        this.options.diagnosticLogger?.("ANDROID_RUNTIME_EMULATOR_RECOVERY_READY", {});
        return;
      }
    } catch (error) {
      this.options.diagnosticLogger?.("ANDROID_RUNTIME_EMULATOR_RECOVERY_FAILED", { error: error instanceof Error ? error.message : String(error) });
    }
    await this.options.bootstrapper.recordState("REPAIR_AVAILABLE", ["ANDROID_RUNTIME_EMULATOR_CRASHED"]).catch(() => undefined);
    this.current = {
      ...this.current,
      bootstrapState: "REPAIR_AVAILABLE",
      supervisorState: "DEGRADED",
      hostOnline: false,
      message: "Android 模拟器自动恢复失败，请修复运行环境",
      diagnostics: [...new Set([...this.current.diagnostics, "ANDROID_RUNTIME_EMULATOR_CRASHED"])],
    };
  }

  private async recoverOnce(): Promise<boolean> {
    if (this.recoveryUsed) return false;
    this.recoveryUsed = true;
    try {
      if (this.deviceManagerValue) {
        await this.deviceManagerValue.stopHost().catch(() => undefined);
        await this.deviceManagerValue.startHost();
        await this.connectBridge();
        await this.bridge?.health();
        this.current = { ...this.current, supervisorState: "READY", hostOnline: true, hostInstalled: true, message: "Android 兼容运行环境已恢复" };
        return true;
      }
    } catch {
      // Continue with the single emulator restart below.
    }
    try {
      await this.emulatorProcess?.stop().catch(() => undefined);
      this.emulatorProcess = undefined;
      this.deviceManagerValue = undefined;
      this.bridge = undefined;
      await this.startAndVerify();
      return true;
    } catch {
      return false;
    }
  }

  private ensureDeviceManager(): AndroidManagedDevice {
    if (this.deviceManagerValue) return this.deviceManagerValue;
    const env = this.options.bootstrapper.commandEnvironment();
    const options: AndroidDeviceManagerOptions = {
      sdkPath: this.options.bootstrapper.sdkPath(),
      serial: ANDROID_RUNTIME_SERIAL,
      env,
      ...(this.options.hostPackage ? { hostPackage: this.options.hostPackage } : {}),
      ...(this.options.hostActivity ? { hostActivity: this.options.hostActivity } : {}),
      ...(this.options.diagnosticLogger ? { diagnosticLogger: this.options.diagnosticLogger } : {}),
      bootTimeoutMs: 180_000,
      bootPollMs: 1_000,
    };
    this.deviceManagerValue = this.options.deviceManagerFactory?.(options)
      ?? new AndroidDeviceManager(options) as unknown as AndroidManagedDevice;
    return this.deviceManagerValue;
  }
}

export class AndroidRuntimeSupervisorError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly runtimeStatus: AndroidRuntimeStatus,
    options?: unknown,
  ) {
    super(message, options instanceof Error ? { cause: options } : undefined);
    this.name = "AndroidRuntimeSupervisorError";
  }
}

function initialStatus(avdName: AndroidRuntimeAvdName): AndroidRuntimeStatus {
  return {
    bootstrapState: "NOT_INSTALLED",
    supervisorState: "STOPPED",
    consentRequired: true,
    runtimeVersion: ANDROID_RUNTIME_VERSION,
    androidApi: ANDROID_RUNTIME_API,
    architecture: ANDROID_RUNTIME_ARCHITECTURE,
    avdName,
    estimatedDownload: ANDROID_RUNTIME_ESTIMATED_DOWNLOAD,
    mode: "auto",
    whpx: "unknown",
    adbFound: false,
    deviceFound: false,
    hostInstalled: false,
    hostOnline: false,
    progress: { stage: "idle", cancellable: false },
    diagnostics: ["ANDROID_RUNTIME_NOT_CHECKED"],
    message: "Android 兼容运行环境尚未安装",
  };
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "ANDROID_RUNTIME_ERROR";
}

async function directorySize(path: string): Promise<number> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const sizes = await Promise.all(entries.map(async (entry) => {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) return directorySize(entryPath);
      if (!entry.isFile()) return 0;
      try {
        return (await stat(entryPath)).size;
      } catch {
        return 0;
      }
    }));
    return sizes.reduce((total, size) => total + size, 0);
  } catch {
    return 0;
  }
}
