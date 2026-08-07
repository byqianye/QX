export type DatabaseErrorCode =
  | "DATABASE_OPEN_FAILED"
  | "DATABASE_MIGRATION_FAILED"
  | "DATABASE_CORRUPT"
  | "DATABASE_VERSION_TOO_NEW"
  | "DATABASE_WRITE_FAILED";

export type DataMigrationErrorCode = "LEGACY_MIGRATION_FAILED";

export type DataLayerErrorCode = DatabaseErrorCode | DataMigrationErrorCode;

export class DataLayerError extends Error {
  public readonly code: DataLayerErrorCode;

  public constructor(code: DataLayerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DataLayerError";
    this.code = code;
  }
}

export function databaseError(
  code: DatabaseErrorCode,
  cause?: unknown,
): DataLayerError {
  return new DataLayerError(code, messageForDatabaseCode(code), {
    ...(cause === undefined ? {} : { cause }),
  });
}

export function legacyMigrationError(cause?: unknown): DataLayerError {
  return new DataLayerError(
    "LEGACY_MIGRATION_FAILED",
    "旧数据迁移失败，原文件已保留，当前会话仍可继续使用。",
    { ...(cause === undefined ? {} : { cause }) },
  );
}

export function isDataLayerError(error: unknown): error is DataLayerError {
  return error instanceof DataLayerError;
}

function messageForDatabaseCode(code: DatabaseErrorCode): string {
  switch (code) {
    case "DATABASE_OPEN_FAILED":
      return "数据库无法打开，当前会话使用安全恢复数据层。";
    case "DATABASE_MIGRATION_FAILED":
      return "数据库迁移失败，原数据库已保留，当前会话使用安全恢复数据层。";
    case "DATABASE_CORRUPT":
      return "数据库文件校验失败，原文件已保留，当前会话使用安全恢复数据层。";
    case "DATABASE_VERSION_TOO_NEW":
      return "数据库版本高于当前程序支持版本，已拒绝降级写入。";
    case "DATABASE_WRITE_FAILED":
      return "数据库写入失败，当前会话仍可继续使用。";
  }
}
