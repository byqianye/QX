import { join, resolve } from "node:path";

export type DataDirectoryMode = "normal";

export interface DataDirectories {
  mode: DataDirectoryMode;
  dataRoot: string;
  database: string;
  cache: string;
  logs: string;
  temp: string;
  backups: string;
}

/**
 * G50 owns the normal user-data layout. Portable mode is deliberately left to
 * G55; all current data consumers still go through this seam.
 */
export class DataDirectoryResolver {
  private readonly userDataRoot: string;

  public constructor(userDataRoot: string) {
    this.userDataRoot = resolve(userDataRoot);
  }

  public resolve(): DataDirectories {
    return {
      mode: "normal",
      dataRoot: this.userDataRoot,
      database: join(this.userDataRoot, "qx-yingshi.db"),
      cache: join(this.userDataRoot, "cache"),
      logs: join(this.userDataRoot, "logs"),
      temp: join(this.userDataRoot, "temp"),
      backups: join(this.userDataRoot, "backups"),
    };
  }
}
