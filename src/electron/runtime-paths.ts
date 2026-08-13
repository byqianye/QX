import { join } from "node:path";

export interface QxRuntimePaths {
  runtimeRoot: string;
  sdkRoot: string;
  adbPath: string;
  emulatorPath: string;
  avdHome: string;
  androidUserHome: string;
  hostApkPath: string;
  runtimeStatePath: string;
  spiderCachePath: string;
}

export interface RuntimePathResolverOptions {
  appPath: string;
  resourcesPath: string;
  userDataPath: string;
  isPackaged: boolean;
  /** Windows LOCALAPPDATA. Kept separate from Electron's roaming userData. */
  localAppDataPath?: string;
}

/** Keeps development paths separate from read-only packaged resources. */
export class RuntimePathResolver {
  private readonly appPath: string;
  private readonly resourcesPath: string;
  private readonly userDataPath: string;
  private readonly isPackaged: boolean;
  private readonly localAppDataPath: string | undefined;

  public constructor(options: RuntimePathResolverOptions) {
    this.appPath = options.appPath;
    this.resourcesPath = options.resourcesPath;
    this.userDataPath = options.userDataPath;
    this.isPackaged = options.isPackaged;
    this.localAppDataPath = options.localAppDataPath;
  }

  public getResourcePath(relativePath = ""): string {
    return join(this.isPackaged ? this.resourcesPath : join(this.appPath, "dist"), relativePath);
  }

  public getRuntimePath(relativePath = ""): string {
    return this.getResourcePath(join("electron-runtime", relativePath));
  }

  public getRendererPath(): string {
    return join(this.appPath, "dist", "renderer");
  }

  public getAndroidHostApkPath(): string {
    return this.isPackaged
      ? join(this.resourcesPath, "android-host", "android-spider-host.apk")
      : join(this.appPath, "android-spider-host", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  }

  /**
   * Android SDK/AVD data is deliberately outside Electron's roaming userData
   * and never falls back to the user's existing Android directories.
   */
  public getAndroidRuntimePath(relativePath = ""): string {
    const root = this.getQxRuntimePaths().runtimeRoot;
    return join(root, relativePath);
  }

  /** Single source of truth for all QX-managed Android Runtime paths. */
  public getQxRuntimePaths(): QxRuntimePaths {
    const runtimeRoot = this.localAppDataPath
      ? join(this.localAppDataPath, "QXMovie", "android-runtime")
      : join(this.userDataPath, "android-runtime");
    const sdkRoot = join(runtimeRoot, "sdk");
    const runtimeStatePath = join(runtimeRoot, "state");
    const platformTools = join(sdkRoot, "platform-tools");
    const emulatorDirectory = join(sdkRoot, "emulator");
    return {
      runtimeRoot,
      sdkRoot,
      adbPath: join(platformTools, process.platform === "win32" ? "adb.exe" : "adb"),
      emulatorPath: join(emulatorDirectory, process.platform === "win32" ? "emulator.exe" : "emulator"),
      avdHome: join(runtimeRoot, "avd"),
      androidUserHome: join(runtimeStatePath, "android-user"),
      hostApkPath: join(runtimeRoot, "host", "android-spider-host.apk"),
      runtimeStatePath,
      spiderCachePath: join(this.userDataPath, "spider-cache"),
    };
  }

  public getAndroidRuntimePaths(): {
    root: string;
    sdk: string;
    avd: string;
    downloads: string;
    host: string;
    state: string;
  } & QxRuntimePaths {
    const qx = this.getQxRuntimePaths();
    const root = qx.runtimeRoot;
    return {
      root,
      sdk: qx.sdkRoot,
      avd: qx.avdHome,
      downloads: join(root, "downloads"),
      host: join(root, "host"),
      state: qx.runtimeStatePath,
      ...qx,
    };
  }

  public getCachePath(): string {
    return join(this.userDataPath, "cache");
  }

  public getLogPath(): string {
    return join(this.userDataPath, "logs");
  }

  public getUserDataPath(): string {
    return this.userDataPath;
  }

  public getBrandIconCandidates(): readonly string[] {
    return this.isPackaged
      ? [
          this.getResourcePath(join("brand", "qx-yingshi.ico")),
          this.getResourcePath("qx-yingshi.ico"),
        ]
      : [join(this.appPath, "build", "assets", "qx-yingshi.ico")];
  }
}
