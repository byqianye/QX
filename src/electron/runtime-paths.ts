import { join } from "node:path";

export interface RuntimePathResolverOptions {
  appPath: string;
  resourcesPath: string;
  userDataPath: string;
  isPackaged: boolean;
}

/** Keeps development paths separate from read-only packaged resources. */
export class RuntimePathResolver {
  private readonly appPath: string;
  private readonly resourcesPath: string;
  private readonly userDataPath: string;
  private readonly isPackaged: boolean;

  public constructor(options: RuntimePathResolverOptions) {
    this.appPath = options.appPath;
    this.resourcesPath = options.resourcesPath;
    this.userDataPath = options.userDataPath;
    this.isPackaged = options.isPackaged;
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
