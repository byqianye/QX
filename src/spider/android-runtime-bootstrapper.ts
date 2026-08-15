import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, mkdirSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";

import { AndroidEnvironmentDoctor } from "./android-environment-doctor.js";
import {
  ANDROID_RUNTIME_SDK_COMPONENT_LOCKS,
  ANDROID_RUNTIME_SDK_PACKAGES,
  buildAndroidRuntimeManifest,
  isAndroidRuntimeManifest,
} from "./android-runtime-manifest.js";

import { NodeAndroidRuntimeCommandRunner, type AndroidRuntimeCommandRunner } from "./android-runtime-process.js";
import type {
  AndroidEnvironmentDoctorResult,
  AndroidRuntimeManifest,
  AndroidRuntimeProgress,
  AndroidRuntimePersistedState,
  AndroidRuntimePaths,
  AndroidRuntimeBootstrapState,
  AndroidRuntimeAvdName,
} from "./android-runtime-types.js";
import {
  ANDROID_RUNTIME_AVD_NAME,
  ANDROID_RUNTIME_COMPACT_AVD_NAME,
  ANDROID_RUNTIME_ADB_SERVER_PORT,
  ANDROID_RUNTIME_API,
  ANDROID_RUNTIME_MIN_FREE_BYTES,
  ANDROID_RUNTIME_SYSTEM_IMAGE,
  ANDROID_RUNTIME_VERSION,
} from "./android-runtime-types.js";

const COMPACT_USERDATA_IMAGE_BYTES = 1024 * 1024 * 1024;
const COMPACT_USERDATA_BLOCK_SIZE = 4096;

export interface AndroidRuntimeBootstrapperOptions {
  paths: AndroidRuntimePaths;
  hostApkPath: string;
  commandRunner?: AndroidRuntimeCommandRunner;
  javaExecutable?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  progressLogger?: (progress: AndroidRuntimeProgress) => void;
  diskSpaceProbe?: (path: string) => number;
  avdName?: AndroidRuntimeAvdName;
}

export interface AndroidRuntimeProvisionOptions {
  consent: boolean;
  forceRepair?: boolean;
}

export interface AndroidRuntimeBootstrapperPort {
  status(): Promise<AndroidRuntimePersistedState>;
  manifest(): Promise<AndroidRuntimeManifest>;
  hostApkPath(): string;
  avdName(): AndroidRuntimeAvdName;
  userdataImagePath(): string | undefined;
  recordState(state: AndroidRuntimeBootstrapState, diagnostics?: readonly string[]): Promise<AndroidRuntimePersistedState>;
  ensureProvisioned(options: AndroidRuntimeProvisionOptions): Promise<AndroidRuntimePersistedState>;
  repair(consent: boolean): Promise<AndroidRuntimePersistedState>;
  cancel(): Promise<AndroidRuntimePersistedState>;
  uninstall(): Promise<void>;
}

export class AndroidRuntimeBootstrapper implements AndroidRuntimeBootstrapperPort {
  private readonly options: Omit<AndroidRuntimeBootstrapperOptions, "commandRunner" | "fetchImpl" | "now" | "platform" | "arch"> & Required<Pick<AndroidRuntimeBootstrapperOptions, "commandRunner" | "fetchImpl" | "now" | "platform" | "arch">>;
  private readonly statePath: string;
  private readonly manifestPath: string;
  private readonly avdNameValue: AndroidRuntimeAvdName;
  private current: AndroidRuntimePersistedState = {
    bootstrapState: "NOT_INSTALLED",
    runtimeVersion: ANDROID_RUNTIME_VERSION,
    updatedAt: new Date(0).toISOString(),
    diagnostics: [],
    progress: { stage: "idle", cancellable: false },
  };
  private operation: Promise<AndroidRuntimePersistedState> | undefined;
  private stateWrite: Promise<void> = Promise.resolve();
  private abortController: AbortController | undefined;
  private integrityValidated = false;

  public constructor(options: AndroidRuntimeBootstrapperOptions) {
    this.options = {
      commandRunner: new NodeAndroidRuntimeCommandRunner(),
      fetchImpl: fetch,
      now: () => new Date(),
      platform: process.platform,
      arch: process.arch,
      ...options,
    };
    this.avdNameValue = options.avdName ?? ANDROID_RUNTIME_AVD_NAME;
    this.statePath = join(options.paths.state, "bootstrap-state.json");
    this.manifestPath = join(options.paths.state, "runtime-manifest.json");
  }

  public async status(): Promise<AndroidRuntimePersistedState> {
    try {
      const value = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
      if (isPersistedState(value)) {
        this.current = { ...value, progress: value.progress ?? defaultProgress(value.bootstrapState) };
        return cloneState(value);
      }
    } catch {
      // A missing or partial state file means first install.
    }
    return cloneState(this.current);
  }

  public async manifest(): Promise<AndroidRuntimeManifest> {
    try {
      const value = JSON.parse(await readFile(this.manifestPath, "utf8")) as unknown;
      if (isManifest(value)) return value;
    } catch {
      // Build the manifest after the host hash is available.
    }
    return buildAndroidRuntimeManifest(await sha256File(this.options.hostApkPath), "1.0.0", this.avdNameValue);
  }

  public hostApkPath(): string {
    return join(this.options.paths.host, "android-spider-host.apk");
  }

  public avdName(): AndroidRuntimeAvdName {
    return this.avdNameValue;
  }

  public userdataImagePath(): string | undefined {
    if (this.avdNameValue !== ANDROID_RUNTIME_COMPACT_AVD_NAME) return undefined;
    return join(this.options.paths.avd, `${this.avdNameValue}.avd`, "userdata-qx-compact.img");
  }

  public recordState(state: AndroidRuntimeBootstrapState, diagnostics: readonly string[] = []): Promise<AndroidRuntimePersistedState> {
    return this.transition(state, diagnostics);
  }

  public async ensureProvisioned(options: AndroidRuntimeProvisionOptions): Promise<AndroidRuntimePersistedState> {
    if (this.operation) return this.operation;
    this.operation = this.ensureProvisionedOnce(options).finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  public repair(consent: boolean): Promise<AndroidRuntimePersistedState> {
    return this.ensureProvisioned({ consent, forceRepair: true });
  }

  public async cancel(): Promise<AndroidRuntimePersistedState> {
    this.abortController?.abort();
    this.abortController = undefined;
    await rm(join(this.options.paths.downloads, "cmdline-tools-extracted"), { recursive: true, force: true }).catch(() => undefined);
    for (const entry of await readdir(this.options.paths.downloads, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && entry.name.endsWith(".part")) await rm(join(this.options.paths.downloads, entry.name), { force: true }).catch(() => undefined);
    }
    return this.transition("REPAIR_AVAILABLE", ["ANDROID_RUNTIME_CANCELLED"], {
      stage: "error",
      message: "安装已取消；已保留完整下载缓存。",
      cancellable: false,
    });
  }

  public async uninstall(): Promise<void> {
    await rm(this.options.paths.root, { recursive: true, force: true });
    this.current = {
      bootstrapState: "NOT_INSTALLED",
      runtimeVersion: ANDROID_RUNTIME_VERSION,
      updatedAt: this.options.now().toISOString(),
      diagnostics: ["ANDROID_RUNTIME_UNINSTALLED"],
      progress: { stage: "idle", cancellable: false },
    };
  }

  private async ensureProvisionedOnce(options: AndroidRuntimeProvisionOptions): Promise<AndroidRuntimePersistedState> {
    const previous = await this.status();
    if (!options.forceRepair && await this.hasRequiredRuntimeFiles()) {
      // A failed emulator/Host start can leave the persisted bootstrap state in
      // REPAIR_AVAILABLE even though every provisioned component is intact.
      // Re-validate the locked manifest and hashes, then recover the state
      // without repeating a multi-GB SDK provision.
      if (previous.bootstrapState === "READY") return previous;
      return this.transition("READY", [], { stage: "ready", message: "Android Runtime components are ready", cancellable: false });
    }
    const existingManifest = await this.readStoredManifest();
    if (existingManifest && compareRuntimeVersions(existingManifest.runtimeVersion, ANDROID_RUNTIME_VERSION) > 0) {
      return this.fail("ANDROID_RUNTIME_DOWNGRADE_BLOCKED", "已安装的 Android Runtime 版本高于当前 RC，已停止安装以避免降级。", ["REPAIR_AVAILABLE"]);
    }
    if (!options.consent) {
      return this.fail("ANDROID_RUNTIME_CONSENT_REQUIRED", "首次使用 Android 来源前需要确认运行环境下载和许可协议。", ["ANDROID_RUNTIME_CONSENT_REQUIRED"]);
    }
    if (this.options.platform !== "win32" || this.options.arch !== "x64") {
      return this.fail("ANDROID_RUNTIME_WINDOWS_X64_ONLY", "Embedded Android Runtime V1 只支持 Windows x64。");
    }
    try {
      await this.ensureDiskSpace();
      this.abortController = new AbortController();
      await this.transition("CHECKING", [], { stage: "preparing", message: "正在准备 QX 专用运行环境…", cancellable: true });
      if (!existsSync(this.options.hostApkPath)) {
        return this.fail("HOST_APK_NOT_FOUND", `Android Host APK 不存在：${this.options.hostApkPath}`);
      }
      await this.prepareDirectories();
      const manifest = buildAndroidRuntimeManifest(await sha256File(this.options.hostApkPath), "1.0.0", this.avdNameValue);
      await writeFile(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await copyFile(this.options.hostApkPath, this.hostApkPath());
      await this.ensureCommandLineTools(manifest);
      await this.transition("INSTALLING", [], { stage: "installing", message: "正在安装锁定的 Android SDK 组件…", cancellable: true });
      await this.runSdkManager(manifest.sdkPackages);
      await this.ensureAvd(manifest);
      const doctor = await this.environmentDoctor();
      if (doctor.whpx !== "ready") {
        return this.fail("WHPX_NOT_READY", doctor.message, doctor.diagnostics);
      }
      return await this.transition("READY", [], { stage: "ready", message: "Android Runtime 已就绪。", cancellable: false });
    } catch (error) {
      return this.fail(errorCode(error), error instanceof Error ? error.message : String(error));
    } finally {
      this.abortController = undefined;
    }
  }

  private async ensureCommandLineTools(manifest: AndroidRuntimeManifest): Promise<void> {
    if (existsSync(this.sdkManagerPath())) return;
    await this.transition("DOWNLOADING", [], { stage: "downloading", message: "正在下载 Android 官方组件…", cancellable: true });
    const archivePath = join(this.options.paths.downloads, `commandlinetools-win-${manifest.commandLineTools.version}.zip`);
    if (existsSync(archivePath)) {
      let archiveIsValid = false;
      try {
        archiveIsValid = await sha256File(archivePath) === manifest.commandLineTools.sha256;
      } catch {
        archiveIsValid = false;
      }
      if (!archiveIsValid) await rm(archivePath, { force: true });
    }
    if (!existsSync(archivePath)) {
      await this.downloadArchive(manifest.commandLineTools.url, archivePath, manifest.commandLineTools.sha256);
    }
    const archiveHash = await sha256File(archivePath);
    if (archiveHash !== manifest.commandLineTools.sha256) {
      throw new Error(`ANDROID_RUNTIME_HASH_MISMATCH: expected ${manifest.commandLineTools.sha256}, received ${archiveHash}`);
    }
    await this.transition("INSTALLING", [], { stage: "installing", message: "正在解压并安装命令行工具…", cancellable: true });
    const extracted = join(this.options.paths.downloads, "cmdline-tools-extracted");
    await rm(extracted, { recursive: true, force: true });
    await mkdir(extracted, { recursive: true });
    await this.extractZip(archivePath, extracted);
    const extractedRoot = (await readdir(extracted, { withFileTypes: true }))
      .find((entry) => entry.isDirectory() && entry.name === "cmdline-tools");
    if (!extractedRoot) throw new Error("ANDROID_RUNTIME_TOOLS_ARCHIVE_INVALID: cmdline-tools directory is missing");
    const target = join(this.options.paths.sdk, "cmdline-tools", "latest");
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await rename(join(extracted, extractedRoot.name), target);
  }

  private async runSdkManager(packages: readonly string[]): Promise<void> {
    const sdkmanager = this.sdkManagerPath();
    const env = this.commandEnvironment();
    this.updateProgress({ stage: "installing", message: "正在安装锁定的 Android SDK 组件…", cancellable: true });
    const licenses = await this.options.commandRunner.run(sdkmanager, ["--sdk_root=" + this.options.paths.sdk, "--licenses"], {
      env,
      input: "y\n".repeat(32),
      timeoutMs: 180_000,
    });
    if (licenses.exitCode !== 0) throw new Error(`ANDROID_RUNTIME_LICENSE_FAILED: ${licenses.stderr || licenses.stdout}`);
    const result = await this.options.commandRunner.run(sdkmanager, ["--sdk_root=" + this.options.paths.sdk, ...packages], {
      env,
      input: "y\n".repeat(32),
      timeoutMs: 30 * 60_000,
    });
    if (result.exitCode !== 0) throw new Error(`ANDROID_RUNTIME_SDK_INSTALL_FAILED: ${result.stderr || result.stdout}`);
  }

  private async ensureAvd(manifest: AndroidRuntimeManifest): Promise<void> {
    await this.transition("CREATING_AVD", [], { stage: "creating-avd", message: "正在创建 QX 专用 Android 运行设备…", cancellable: true });
    const avdmanager = this.avdManagerPath();
    const listed = await this.options.commandRunner.run(avdmanager, ["list", "avd", "-c"], {
      env: this.commandEnvironment(),
      timeoutMs: 30_000,
    });
    if (listed.exitCode !== 0) throw new Error(`ANDROID_RUNTIME_AVD_LIST_FAILED: ${listed.stderr || listed.stdout}`);
    const avdExists = listed.stdout.split(/\r?\n/u).map((line) => line.trim()).includes(this.avdNameValue);
    if (!avdExists) {
      const result = await this.options.commandRunner.run(avdmanager, [
        "create", "avd", "-n", this.avdNameValue,
        "-k", manifest.android.image,
        "-p", join(this.options.paths.avd, `${this.avdNameValue}.avd`),
        "-f",
      ], {
        env: this.commandEnvironment(),
        input: "no\n",
        timeoutMs: 120_000,
      });
      if (result.exitCode !== 0) throw new Error(`ANDROID_RUNTIME_AVD_CREATE_FAILED: ${result.stderr || result.stdout}`);
    }
    if (this.avdNameValue === ANDROID_RUNTIME_COMPACT_AVD_NAME) {
      await this.configureCompactAvd();
      await this.ensureCompactUserdataImage();
    }
  }

  private async configureCompactAvd(): Promise<void> {
    const configPath = join(this.options.paths.avd, `${this.avdNameValue}.avd`, "config.ini");
    if (!existsSync(configPath)) throw new Error(`ANDROID_RUNTIME_AVD_CONFIG_MISSING: ${configPath}`);
    const current = await readFile(configPath, "utf8");
    const settings: Readonly<Record<string, string>> = {
      // Keep the AVD profile compact as a baseline. The actual writable data
      // partition is the dedicated userdata-qx-compact.img passed with -data;
      // API 35 may rewrite this legacy config field during boot.
      "disk.dataPartition.size": "1073741824",
      "hw.ramSize": "1024M",
      "hw.audioInput": "no",
      "hw.audioOutput": "no",
      "hw.camera.back": "none",
      "hw.camera.front": "none",
      "hw.sdCard": "no",
      "firstboot.bootFromDownloadableSnapshot": "no",
      "firstboot.bootFromLocalSnapshot": "no",
      "firstboot.saveToLocalSnapshot": "no",
      "fastboot.forceChosenSnapshotBoot": "no",
      "fastboot.forceColdBoot": "yes",
      "fastboot.forceFastBoot": "no",
    };
    let next = current;
    for (const [key, value] of Object.entries(settings)) {
      const assignment = `${key}=${value}`;
      const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "mu");
      next = pattern.test(next)
        ? next.replace(pattern, assignment)
        : `${next.trimEnd()}\n${assignment}\n`;
    }
    if (next !== current) await writeFile(configPath, next, "utf8");
  }

  private async ensureCompactUserdataImage(): Promise<void> {
    const imagePath = this.userdataImagePath();
    if (!imagePath) return;
    const expectedBytes = COMPACT_USERDATA_IMAGE_BYTES;
    try {
      const current = await stat(imagePath);
      if (current.size === expectedBytes) return;
      throw new Error(`ANDROID_RUNTIME_COMPACT_USERDATA_INVALID: expected ${expectedBytes} bytes, found ${current.size}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const tool = join(
      this.options.paths.sdk,
      "platform-tools",
      this.options.platform === "win32" ? "mke2fs.exe" : "mke2fs",
    );
    if (!existsSync(tool)) throw new Error(`ANDROID_RUNTIME_COMPACT_USERDATA_TOOL_MISSING: ${tool}`);
    const partial = `${imagePath}.part`;
    await rm(partial, { force: true });
    const result = await this.options.commandRunner.run(tool, [
      "-t", "ext4",
      "-b", "4096",
      "-m", "0",
      "-L", "data",
      "-F",
      partial,
      String(expectedBytes / COMPACT_USERDATA_BLOCK_SIZE),
    ], {
      env: this.commandEnvironment(),
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0) {
      await rm(partial, { force: true });
      throw new Error(`ANDROID_RUNTIME_COMPACT_USERDATA_CREATE_FAILED: ${result.stderr || result.stdout}`);
    }
    const created = await stat(partial).catch(() => undefined);
    if (!created || created.size !== expectedBytes) {
      await rm(partial, { force: true });
      throw new Error(`ANDROID_RUNTIME_COMPACT_USERDATA_CREATE_FAILED: expected ${expectedBytes} bytes`);
    }
    await rename(partial, imagePath);
  }

  public async environmentDoctor(): Promise<AndroidEnvironmentDoctorResult> {
    const emulator = this.emulatorPath();
    return new AndroidEnvironmentDoctor({
      ...(existsSync(emulator) ? { emulatorPath: emulator } : {}),
      commandRunner: this.options.commandRunner,
      env: this.commandEnvironment(),
    }).check();
  }

  public sdkPath(): string {
    return this.options.paths.sdk;
  }

  public emulatorPath(): string {
    return join(this.options.paths.sdk, "emulator", this.options.platform === "win32" ? "emulator.exe" : "emulator");
  }

  public commandEnvironment(): NodeJS.ProcessEnv {
    const bin = [
      join(this.options.paths.sdk, "platform-tools"),
      join(this.options.paths.sdk, "emulator"),
      join(this.options.paths.sdk, "cmdline-tools", "latest", "bin"),
    ];
    const javaHome = this.options.javaExecutable ? dirname(dirname(this.options.javaExecutable)) : undefined;
    const androidUserHome = join(this.options.paths.state, "android-user");
    const isolatedTemp = join(this.options.paths.state, "tmp");
    mkdirSync(isolatedTemp, { recursive: true });
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const powershellPath = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const commandShellPath = join(systemRoot, "System32", "cmd.exe");
    const isolatedPath = [
      ...bin,
      ...(javaHome ? [join(javaHome, "bin")] : []),
      // sdkmanager.bat uses Windows' findstr.exe for its Java version check.
      // This is the OS utility path only; Android executables remain absolute
      // and are pinned below so system adb cannot be selected.
      join(systemRoot, "System32"),
    ].join(";");
    const dedicatedAdbPath = join(this.options.paths.sdk, "platform-tools", this.options.platform === "win32" ? "adb.exe" : "adb");
    const dedicatedEmulatorPath = this.emulatorPath();
    const inheritedEnvironment = { ...process.env };
    // avdmanager interprets the legacy ANDROID_SDK_HOME differently from
    // ANDROID_USER_HOME and fails to locate the managed AVD .ini when it is
    // set. Remove it so the official tool uses the dedicated user-home vars.
    delete inheritedEnvironment.ANDROID_SDK_HOME;
    return {
      ...inheritedEnvironment,
      QX_ANDROID_HOME: this.options.paths.sdk,
      QX_ANDROID_AVD_HOME: this.options.paths.avd,
      ANDROID_HOME: this.options.paths.sdk,
      ANDROID_SDK_ROOT: this.options.paths.sdk,
      ANDROID_AVD_HOME: this.options.paths.avd,
      ANDROID_USER_HOME: androidUserHome,
      ANDROID_EMULATOR_HOME: androidUserHome,
      TEMP: isolatedTemp,
      TMP: isolatedTemp,
      ANDROID_ADB_SERVER_PORT: String(ANDROID_RUNTIME_ADB_SERVER_PORT),
      ADB_SERVER_SOCKET: `tcp:${ANDROID_RUNTIME_ADB_SERVER_PORT}`,
      ...(javaHome ? { JAVA_HOME: javaHome } : {}),
      QX_ANDROID_POWERSHELL_PATH: powershellPath,
      QX_ANDROID_EMULATOR_PATH: dedicatedEmulatorPath,
      ADB: dedicatedAdbPath,
      ComSpec: commandShellPath,
      COMSPEC: commandShellPath,
      Path: isolatedPath,
      PATH: isolatedPath,
    };
  }

  private sdkManagerPath(): string {
    return join(this.options.paths.sdk, "cmdline-tools", "latest", "bin", this.options.platform === "win32" ? "sdkmanager.bat" : "sdkmanager");
  }

  private avdManagerPath(): string {
    return join(this.options.paths.sdk, "cmdline-tools", "latest", "bin", this.options.platform === "win32" ? "avdmanager.bat" : "avdmanager");
  }

  private async prepareDirectories(): Promise<void> {
    for (const directory of [
      this.options.paths.root,
      this.options.paths.sdk,
      this.options.paths.avd,
      this.options.paths.downloads,
      this.options.paths.host,
      this.options.paths.state,
    ]) await mkdir(directory, { recursive: true });
  }

  private async hasRequiredRuntimeFiles(): Promise<boolean> {
    const requiredRuntimePaths: string[] = [
      this.sdkManagerPath(),
      this.avdManagerPath(),
      join(this.options.paths.sdk, "platform-tools", this.options.platform === "win32" ? "adb.exe" : "adb"),
      this.emulatorPath(),
      join(this.options.paths.sdk, "system-images", `android-${ANDROID_RUNTIME_API}`, "google_apis", "x86_64"),
      join(this.options.paths.avd, `${this.avdNameValue}.avd`),
      this.hostApkPath(),
    ];
    const compactImage = this.userdataImagePath();
    if (compactImage) {
      requiredRuntimePaths.push(compactImage);
      requiredRuntimePaths.push(join(this.options.paths.sdk, "platform-tools", this.options.platform === "win32" ? "mke2fs.exe" : "mke2fs"));
    }
    if (requiredRuntimePaths.some((path) => !existsSync(path))) return false;
    if (compactImage) {
      try {
        if ((await stat(compactImage)).size !== COMPACT_USERDATA_IMAGE_BYTES) return false;
      } catch {
        return false;
      }
    }
    try {
     const storedManifest = JSON.parse(await readFile(this.manifestPath, "utf8")) as unknown;
      const managedHostHash = await sha256File(this.hostApkPath());
      const sourceHostHash = await sha256File(this.options.hostApkPath);
      if (this.integrityValidated) return true;
      const componentHashes = await Promise.all([
        sha256Directory(join(this.options.paths.sdk, ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.platformTools.relativePath)),
        sha256Directory(join(this.options.paths.sdk, ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.emulator.relativePath)),
        sha256Directory(join(this.options.paths.sdk, ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.platform.relativePath)),
        sha256Directory(join(this.options.paths.sdk, ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.systemImage.relativePath)),
      ]);
      const valid = componentHashes[0] === ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.platformTools.sha256
        && componentHashes[1] === ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.emulator.sha256
        && componentHashes[2] === ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.platform.sha256
        && componentHashes[3] === ANDROID_RUNTIME_SDK_COMPONENT_LOCKS.systemImage.sha256
        && managedHostHash === sourceHostHash;
      if (valid && (!isAndroidRuntimeManifest(storedManifest)
        || storedManifest.host.sha256 !== sourceHostHash
        || storedManifest.android.avdName !== this.avdNameValue)) {
        await writeFile(this.manifestPath, `${JSON.stringify(buildAndroidRuntimeManifest(sourceHostHash, "1.0.0", this.avdNameValue), null, 2)}\n`, "utf8");
      }
      this.integrityValidated = valid;
      return valid;
    } catch {
      return false;
    }
  }

  private async transition(state: AndroidRuntimeBootstrapState, diagnostics: readonly string[] = [], progress = defaultProgress(state)): Promise<AndroidRuntimePersistedState> {
    this.current = {
      bootstrapState: state,
      runtimeVersion: ANDROID_RUNTIME_VERSION,
      updatedAt: this.options.now().toISOString(),
      diagnostics: [...diagnostics],
      progress,
    };
    await this.persistState();
    return cloneState(this.current);
  }

  private async fail(code: string, message: string, diagnostics: readonly string[] = []): Promise<AndroidRuntimePersistedState> {
    await this.transition("ERROR", [code, ...diagnostics], { stage: "error", message, cancellable: false });
    return this.transition("REPAIR_AVAILABLE", [code, ...diagnostics], { stage: "error", message, cancellable: false });
  }

  private updateProgress(progress: AndroidRuntimeProgress): void {
    this.current = { ...this.current, progress };
    this.options.progressLogger?.(progress);
    void this.persistState().catch(() => undefined);
  }

  private persistState(): Promise<void> {
    const snapshot = `${JSON.stringify(this.current, null, 2)}\n`;
    const write = this.stateWrite.then(async () => {
      await mkdir(this.options.paths.state, { recursive: true });
      await writeFile(this.statePath, snapshot, "utf8");
    });
    this.stateWrite = write.catch(() => undefined);
    return write;
  }

  private async readStoredManifest(): Promise<AndroidRuntimeManifest | undefined> {
    try {
      const value = JSON.parse(await readFile(this.manifestPath, "utf8")) as unknown;
      return isManifest(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async ensureDiskSpace(): Promise<void> {
    const target = existsSync(this.options.paths.root) ? this.options.paths.root : dirname(this.options.paths.root);
    try {
      const available = this.options.diskSpaceProbe
        ? this.options.diskSpaceProbe(target)
        : (() => {
          const stats = statfsSync(target);
          return Number(stats.bavail) * Number(stats.bsize);
        })();
      if (available < ANDROID_RUNTIME_MIN_FREE_BYTES) {
        throw new Error(`ANDROID_RUNTIME_INSUFFICIENT_DISK_SPACE: 需要至少 ${(ANDROID_RUNTIME_MIN_FREE_BYTES / (1024 ** 3)).toFixed(1)} GB 可用空间，当前约 ${(available / (1024 ** 3)).toFixed(1)} GB。`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("ANDROID_RUNTIME_INSUFFICIENT_DISK_SPACE")) throw error;
    }
  }

  private async downloadArchive(url: string, archivePath: string, expectedSha256: string): Promise<void> {
    const partialPath = `${archivePath}.part`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let offset = 0;
      try { offset = (await stat(partialPath)).size; } catch { offset = 0; }
      try {
        const response = await this.options.fetchImpl(url, {
          ...(offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {}),
          ...(this.abortController ? { signal: this.abortController.signal } : {}),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (offset > 0 && response.status !== 206) {
          await rm(partialPath, { force: true });
          offset = 0;
        }
        const contentLength = Number(response.headers.get("content-length") ?? 0) || undefined;
        const totalBytes = contentLength ? contentLength + offset : undefined;
        const startedAt = Date.now();
        const handle = await open(partialPath, offset > 0 ? "a" : "w");
        let downloadedBytes = offset;
        try {
          if (response.body) {
            const reader = response.body.getReader();
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (!chunk.value) continue;
              await handle.write(chunk.value);
              downloadedBytes += chunk.value.byteLength;
              const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
              const speed = Math.round((downloadedBytes - offset) / elapsedSeconds);
              this.updateProgress({ stage: "downloading", downloadedBytes, ...(totalBytes ? { totalBytes } : {}), speedBytesPerSecond: speed, ...(totalBytes && speed > 0 ? { remainingSeconds: Math.max(0, (totalBytes - downloadedBytes) / speed) } : {}), cancellable: true });
            }
          } else {
            const bytes = Buffer.from(await response.arrayBuffer());
            await handle.write(bytes);
            downloadedBytes += bytes.length;
          }
        } finally {
          await handle.close();
        }
        this.updateProgress({ stage: "validating", downloadedBytes, ...(totalBytes ? { totalBytes } : {}), cancellable: true });
        const actual = await sha256File(partialPath);
        if (actual !== expectedSha256) {
          await rm(partialPath, { force: true });
          throw new Error(`ANDROID_RUNTIME_HASH_MISMATCH: expected ${expectedSha256}, received ${actual}`);
        }
        await rename(partialPath, archivePath);
        return;
      } catch (error) {
        if (this.abortController?.signal.aborted) throw new Error("ANDROID_RUNTIME_CANCELLED");
        lastError = error;
        if (attempt < 2) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100 * (attempt + 1)));
      }
    }
    throw new Error(`ANDROID_RUNTIME_DOWNLOAD_FAILED: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private extractZip(archivePath: string, destination: string): Promise<void> {
    if (this.options.platform !== "win32") return Promise.reject(new Error("ANDROID_RUNTIME_WINDOWS_ONLY"));
    const script = `Expand-Archive -LiteralPath '${powershellQuote(archivePath)}' -DestinationPath '${powershellQuote(destination)}' -Force`;
    const env = this.commandEnvironment();
    return this.options.commandRunner.run(env.QX_ANDROID_POWERSHELL_PATH ?? "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      timeoutMs: 120_000,
      env,
    }).then((result) => {
      if (result.exitCode !== 0) throw new Error(`ANDROID_RUNTIME_EXTRACT_FAILED: ${result.stderr || result.stdout}`);
    });
  }
}

function powershellQuote(value: string): string {
  return value.replace(/'/gu, "''");
}

function cloneState(state: AndroidRuntimePersistedState): AndroidRuntimePersistedState {
  return {
    ...state,
    diagnostics: [...state.diagnostics],
    ...(state.progress ? { progress: { ...state.progress } } : {}),
  };
}

function isPersistedState(value: unknown): value is AndroidRuntimePersistedState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.bootstrapState === "string"
    && typeof record.runtimeVersion === "string"
    && typeof record.updatedAt === "string"
    && Array.isArray(record.diagnostics)
    && record.diagnostics.every((item) => typeof item === "string");
}

function isManifest(value: unknown): value is AndroidRuntimeManifest {
  return isAndroidRuntimeManifest(value);
}

async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256Directory(root: string): Promise<string> {
  const files = await directoryFiles(root);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file}\0`);
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(join(root, file));
      stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
      stream.on("end", resolvePromise);
      stream.on("error", reject);
    });
    hash.update("\0");
  }
  return hash.digest("hex").toUpperCase();
}

async function directoryFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await directoryFiles(root, path));
    else if (entry.isFile()) files.push(path.slice(root.length + 1).replaceAll("\\", "/"));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function defaultProgress(state: AndroidRuntimeBootstrapState): AndroidRuntimeProgress {
  const stage = state === "READY"
    ? "ready"
    : state === "DOWNLOADING"
      ? "downloading"
      : state === "CREATING_AVD"
        ? "creating-avd"
        : state === "INSTALLING_HOST"
          ? "installing-host"
          : state === "VERIFYING"
            ? "verifying"
            : state === "ERROR" || state === "REPAIR_AVAILABLE"
              ? "error"
              : state === "NOT_INSTALLED"
                ? "idle"
                : state === "INSTALLING"
                  ? "installing"
                  : "preparing";
  return { stage, cancellable: stage === "downloading" || stage === "installing" || stage === "preparing" };
}

function compareRuntimeVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number, string] => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.*))?$/u.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""] : [0, 0, 0, value];
  };
  const a = parse(left);
  const b = parse(right);
  for (const index of [0, 1, 2] as const) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  if (!a[3] && b[3]) return 1;
  if (a[3] && !b[3]) return -1;
  return a[3].localeCompare(b[3]);
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "ANDROID_RUNTIME_PROVISION_FAILED";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
