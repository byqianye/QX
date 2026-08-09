import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AndroidDevice {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  transportId?: string;
  androidVersion?: string;
  sdkInt?: number;
  abi?: string;
  bootCompleted?: boolean;
}

export interface AndroidEnvironmentSnapshot {
  sdkPath?: string;
  sdkFound: boolean;
  adbPath?: string;
  adbFound: boolean;
  adbVersion?: string;
  emulatorPath?: string;
  emulatorFound: boolean;
  avds: readonly string[];
  devices: readonly AndroidDevice[];
  device?: AndroidDevice;
  deviceFound: boolean;
  diagnostics: readonly string[];
}

export interface AndroidDeviceManagerPort {
  requireDevice(): Promise<AndroidDevice>;
  forward(localPort: number, remotePort: number): Promise<void>;
  removeForward(localPort: number): Promise<void>;
  install(apkPath: string): Promise<void>;
  startHost(): Promise<void>;
  stopHost(): Promise<void>;
  push(localPath: string, remotePath: string): Promise<void>;
  shell(args: readonly string[]): Promise<string>;
  waitForBoot?(): Promise<AndroidDevice>;
}

export interface AndroidDeviceManagerOptions {
  sdkPath?: string;
  adbPath?: string;
  serial?: string;
  hostPackage?: string;
  hostActivity?: string;
  commandTimeoutMs?: number;
  installTimeoutMs?: number;
  bootTimeoutMs?: number;
  bootPollMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class AndroidDeviceManagerError extends Error {
  public constructor(
    public readonly code: "ANDROID_SDK_NOT_FOUND" | "ADB_NOT_FOUND" | "ANDROID_DEVICE_NOT_FOUND" | "ANDROID_DEVICE_SERIAL_REQUIRED" | "ANDROID_DEVICE_BOOT_TIMEOUT" | "ANDROID_HOST_NOT_INSTALLED" | "ADB_COMMAND_FAILED",
    message: string,
    public readonly diagnostics?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AndroidDeviceManagerError";
  }
}

interface AdbResult {
  stdout: string;
  stderr: string;
}

export class AndroidDeviceManager implements AndroidDeviceManagerPort {
  private readonly options: Required<Pick<AndroidDeviceManagerOptions, "commandTimeoutMs" | "installTimeoutMs" | "bootTimeoutMs" | "bootPollMs" | "hostPackage" | "hostActivity">> & AndroidDeviceManagerOptions;
  private adbPathValue: string | undefined;
  private emulatorPathValue: string | undefined;
  private deviceValue: AndroidDevice | undefined;

  public constructor(options: AndroidDeviceManagerOptions = {}) {
    this.options = {
      commandTimeoutMs: 10_000,
      installTimeoutMs: 120_000,
      bootTimeoutMs: 120_000,
      bootPollMs: 1_000,
      hostPackage: "com.qx.yingshi.androidhost",
      hostActivity: "com.qx.yingshi.androidhost.MainActivity",
      ...options,
    };
  }

  public get sdkPath(): string | undefined {
    return resolveSdkPath(this.options.sdkPath, this.options.env ?? process.env);
  }

  public get adbPath(): string | undefined {
    return this.adbPathValue;
  }

  public async check(): Promise<AndroidEnvironmentSnapshot> {
    const diagnostics: string[] = [];
    const sdkPath = this.sdkPath;
    if (!sdkPath) diagnostics.push("ANDROID_SDK_NOT_FOUND");

    let adbPath: string | undefined;
    let adbVersion: string | undefined;
    let emulatorPath: string | undefined;
    let avds: readonly string[] = [];
    let devices: readonly AndroidDevice[] = [];
    try {
      adbPath = await this.resolveAdbPath();
      adbVersion = await this.version();
      devices = await this.listDevices();
    } catch (error) {
      const code = error instanceof AndroidDeviceManagerError ? error.code : "ADB_NOT_FOUND";
      diagnostics.push(code);
    }

    try {
      emulatorPath = await this.resolveEmulatorPath();
      avds = await this.listAvds();
    } catch {
      // A physical device is a valid Android runtime; emulator discovery is diagnostic only.
    }

    let device = selectDevice(devices, this.options.serial);
    if (device?.state === "device") {
      device = await this.enrichDevice(device);
    }
    if (this.options.serial === undefined && multiplePhysicalDevicesRequireSerial(devices)) {
      diagnostics.push("ANDROID_DEVICE_SERIAL_REQUIRED");
      device = undefined;
    }
    if (!device || device.state !== "device") diagnostics.push("ANDROID_DEVICE_NOT_FOUND");
    if (device?.state === "device") this.deviceValue = device;
    return {
      ...(sdkPath ? { sdkPath } : {}),
      sdkFound: sdkPath !== undefined,
      ...(adbPath ? { adbPath } : {}),
      adbFound: adbPath !== undefined,
      ...(adbVersion ? { adbVersion } : {}),
      ...(emulatorPath ? { emulatorPath } : {}),
      emulatorFound: emulatorPath !== undefined,
      avds,
      devices,
      ...(device ? { device } : {}),
      deviceFound: device?.state === "device",
      diagnostics: [...new Set(diagnostics)],
    };
  }

  public async version(): Promise<string> {
    const result = await this.runAdb(["version"], false);
    return result.stdout.trim() || result.stderr.trim();
  }

  public async listDevices(): Promise<readonly AndroidDevice[]> {
    const result = await this.runAdb(["devices", "-l"], false);
    const devices = parseDevices(result.stdout);
    return devices;
  }

  public async requireDevice(): Promise<AndroidDevice> {
    const devices = await this.listDevices();
    const selected = selectDevice(devices, this.options.serial);
    if (!this.options.serial && multiplePhysicalDevicesRequireSerial(devices)) {
      throw new AndroidDeviceManagerError(
        "ANDROID_DEVICE_SERIAL_REQUIRED",
        "Multiple physical Android devices are online; set QX_ANDROID_DEVICE_SERIAL",
        { devices },
      );
    }
    if (!selected || selected.state !== "device") {
      throw new AndroidDeviceManagerError(
        "ANDROID_DEVICE_NOT_FOUND",
        this.options.serial
          ? `Android device is not ready: ${this.options.serial}`
          : "No online Android device is available",
        { serial: this.options.serial ?? "", devices },
      );
    }
    this.deviceValue = await this.enrichDevice(selected);
    return this.deviceValue;
  }

  public async waitForBoot(): Promise<AndroidDevice> {
    const device = this.deviceValue ?? await this.requireDevice();
    const deadline = Date.now() + this.options.bootTimeoutMs;
    let current = device;
    while (Date.now() <= deadline) {
      current = await this.enrichDevice(current);
      if (current.bootCompleted) {
        this.deviceValue = current;
        return current;
      }
      await delay(Math.min(this.options.bootPollMs, Math.max(1, deadline - Date.now())));
    }
    throw new AndroidDeviceManagerError(
      "ANDROID_DEVICE_BOOT_TIMEOUT",
      `Android device did not finish booting within ${this.options.bootTimeoutMs}ms: ${current.serial}`,
      { serial: current.serial, timeoutMs: this.options.bootTimeoutMs, device: current },
    );
  }

  public async forward(localPort: number, remotePort: number): Promise<void> {
    const device = await this.requireDevice();
    await this.runAdb(["-s", device.serial, "forward", `tcp:${localPort}`, `tcp:${remotePort}`], false);
  }

  public async removeForward(localPort: number): Promise<void> {
    const device = this.deviceValue ?? await this.requireDevice();
    try {
      await this.runAdb(["-s", device.serial, "forward", "--remove", `tcp:${localPort}`], false);
    } catch (error) {
      if (!(error instanceof AndroidDeviceManagerError) || error.code !== "ADB_COMMAND_FAILED") throw error;
    }
  }

  public async install(apkPath: string): Promise<void> {
    const device = await this.requireDevice();
    await this.runAdb(["-s", device.serial, "install", "-r", apkPath], false, this.options.installTimeoutMs);
    if (!(await this.isHostInstalled())) {
      throw new AndroidDeviceManagerError(
        "ANDROID_HOST_NOT_INSTALLED",
        `Android Host package was not found after install: ${this.options.hostPackage}`,
        { packageName: this.options.hostPackage, apkPath, serial: device.serial },
      );
    }
  }

  public async startHost(): Promise<void> {
    const device = this.deviceValue ?? await this.requireDevice();
    const result = await this.runAdb([
      "-s", device.serial, "shell", "am", "start", "-n",
      `${this.options.hostPackage}/${this.options.hostActivity}`,
    ], false);
    if (/\berror(?:\s+type)?\b/iu.test(result.stdout) || /\berror(?:\s+type)?\b/iu.test(result.stderr)) {
      throw new AndroidDeviceManagerError("ADB_COMMAND_FAILED", "Unable to start Android Spider Host", {
        packageName: this.options.hostPackage,
        activity: this.options.hostActivity,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
  }

  public async stopHost(): Promise<void> {
    const device = this.deviceValue ?? await this.requireDevice();
    await this.runAdb(["-s", device.serial, "shell", "am", "force-stop", this.options.hostPackage], false);
  }

  public async push(localPath: string, remotePath: string): Promise<void> {
    const device = this.deviceValue ?? await this.requireDevice();
    await this.runAdb(["-s", device.serial, "push", localPath, remotePath], false);
  }

  public async shell(args: readonly string[]): Promise<string> {
    const device = this.deviceValue ?? await this.requireDevice();
    const result = await this.runAdb(["-s", device.serial, "shell", ...args], false);
    return result.stdout.trim();
  }

  public async isHostInstalled(): Promise<boolean> {
    try {
      const result = await this.shell(["pm", "path", this.options.hostPackage]);
      return /^package:/mu.test(result);
    } catch {
      return false;
    }
  }

  public async resolveAdbPath(): Promise<string> {
    if (this.adbPathValue) return this.adbPathValue;
    const env = this.options.env ?? process.env;
    const sdkPath = this.sdkPath;
    const candidates = [
      this.options.adbPath,
      env.ADB,
      sdkPath ? join(sdkPath, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb") : undefined,
      findOnPath(process.platform === "win32" ? "adb.exe" : "adb", env.Path ?? env.PATH),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const candidate of candidates) {
      if (candidate === "adb" || candidate === "adb.exe" || existsSync(candidate)) {
        this.adbPathValue = candidate;
        return candidate;
      }
    }
    throw new AndroidDeviceManagerError("ADB_NOT_FOUND", "Android Debug Bridge (adb) was not found", {
      sdkPath: sdkPath ?? "",
      candidates,
    });
  }

  public async resolveEmulatorPath(): Promise<string> {
    if (this.emulatorPathValue) return this.emulatorPathValue;
    const env = this.options.env ?? process.env;
    const sdkPath = this.sdkPath;
    const command = process.platform === "win32" ? "emulator.exe" : "emulator";
    const candidates = [
      this.options.env?.QX_ANDROID_EMULATOR_PATH,
      sdkPath ? join(sdkPath, "emulator", command) : undefined,
      findOnPath(command, env.Path ?? env.PATH),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const candidate of candidates) {
      if (candidate === "emulator" || candidate === "emulator.exe" || existsSync(candidate)) {
        this.emulatorPathValue = candidate;
        return candidate;
      }
    }
    throw new AndroidDeviceManagerError("ADB_NOT_FOUND", "Android emulator binary was not found", { sdkPath: sdkPath ?? "", candidates });
  }

  public async listAvds(): Promise<readonly string[]> {
    const emulator = await this.resolveEmulatorPath();
    try {
      const result = await execFileAsync(emulator, ["-list-avds"], {
        env: this.options.env ?? process.env,
        encoding: "utf8",
        timeout: this.options.commandTimeoutMs,
        windowsHide: true,
      });
      return result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    } catch (error) {
      throw new AndroidDeviceManagerError("ADB_COMMAND_FAILED", "Unable to list Android AVDs", { emulatorPath: emulator }, { cause: error });
    }
  }

  private async enrichDevice(device: AndroidDevice): Promise<AndroidDevice> {
    if (device.state !== "device") return device;
    try {
      const result = await this.runAdb(["-s", device.serial, "shell", "getprop"], false);
      return { ...device, ...parseAndroidDeviceProperties(result.stdout) };
    } catch {
      return device;
    }
  }

  private async runAdb(args: readonly string[], _withDevice: boolean, timeoutMs = this.options.commandTimeoutMs): Promise<AdbResult> {
    const adb = await this.resolveAdbPath();
    try {
      const result = await execFileAsync(adb, [...args], {
        cwd: this.options.env?.QX_ANDROID_WORKING_DIRECTORY,
        env: this.options.env ?? process.env,
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const value = error as { stdout?: string; stderr?: string; code?: unknown; killed?: boolean };
      const stdout = value.stdout ?? "";
      const stderr = value.stderr ?? "";
      const message = value.killed
        ? "adb command timed out"
        : `adb command failed: ${args.join(" ")}`;
      throw new AndroidDeviceManagerError("ADB_COMMAND_FAILED", message, {
        adbPath: adb,
        args,
        stdout,
        stderr,
        exitCode: value.code ?? "unknown",
      }, { cause: error });
    }
  }
}

function resolveSdkPath(explicit: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const candidates = [
    explicit,
    env.QX_ANDROID_SDK_PATH,
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    process.platform === "win32" && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Android", "Sdk") : undefined,
    join(homedir(), "Android", "Sdk"),
    join(homedir(), ".workbuddy", "android-toolchain", "sdk"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return candidates.find((value) => existsSync(value));
}

function findOnPath(command: string, pathValue: string | undefined): string | undefined {
  if (!pathValue) return undefined;
  for (const directory of pathValue.split(delimiter)) {
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  try {
    const lookup = process.platform === "win32" ? "where.exe" : "which";
    const result = execFileSync(lookup, [command], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const first = result.trim().split(/\r?\n/u)[0];
    return first || undefined;
  } catch {
    return undefined;
  }
}

function parseDevices(stdout: string): AndroidDevice[] {
  return stdout
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [serial = "", state = "unknown", ...attributes] = line.split(/\s+/u);
      const values: Record<string, string> = {};
      for (const attribute of attributes) {
        const separator = attribute.indexOf(":");
        if (separator > 0) values[attribute.slice(0, separator)] = attribute.slice(separator + 1);
      }
      return {
        serial,
        state,
        ...(values.model ? { model: values.model } : {}),
        ...(values.product ? { product: values.product } : {}),
        ...(values.transport_id ? { transportId: values.transport_id } : {}),
      };
    });
}

export function selectAndroidDevice(devices: readonly AndroidDevice[], serial: string | undefined): AndroidDevice | undefined {
  if (serial) return devices.find((device) => device.serial === serial);
  const ready = devices.filter((device) => device.state === "device");
  const emulator = ready.find((device) => device.serial.startsWith("emulator-"));
  if (emulator) return emulator;
  return ready.length === 1 ? ready[0] : undefined;
}

function selectDevice(devices: readonly AndroidDevice[], serial: string | undefined): AndroidDevice | undefined {
  return selectAndroidDevice(devices, serial);
}

function multiplePhysicalDevicesRequireSerial(devices: readonly AndroidDevice[]): boolean {
  const ready = devices.filter((device) => device.state === "device");
  return ready.length > 1 && !ready.some((device) => device.serial.startsWith("emulator-"));
}

export function parseAndroidDeviceProperties(stdout: string): Pick<AndroidDevice, "model" | "androidVersion" | "sdkInt" | "abi" | "bootCompleted"> {
  const properties: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/u)) {
    const match = line.match(/^\[([^\]]+)\]: \[([^\]]*)\]$/u);
    if (match?.[1] !== undefined && match[2] !== undefined) properties[match[1]] = match[2];
  }
  const sdk = Number.parseInt(properties["ro.build.version.sdk"] ?? "", 10);
  const abi = properties["ro.product.cpu.abilist"]?.split(",")[0]?.trim() || properties["ro.product.cpu.abi"];
  const boot = properties["sys.boot_completed"] === "1" || properties["dev.bootcomplete"] === "1";
  return {
    ...(properties["ro.product.model"] ? { model: properties["ro.product.model"] } : {}),
    ...(properties["ro.build.version.release"] ? { androidVersion: properties["ro.build.version.release"] } : {}),
    ...(Number.isInteger(sdk) ? { sdkInt: sdk } : {}),
    ...(abi ? { abi } : {}),
    bootCompleted: boot,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
