export interface RuntimeErrorContext {
  runtimeKind?: string;
  siteKey?: string;
  sourceKey?: string;
  sourceName?: string;
  artifactUrl?: string;
  artifactPath?: string;
  workingDirectory?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  rootCause?: string;
  includeStack?: boolean;
}

export interface RuntimeErrorInfo {
  code: string;
  message: string;
  syscall?: string;
  path?: string;
  missingPath?: string;
  sourceKey?: string;
  sourceName?: string;
  runtime?: string;
  siteKey?: string;
  artifactUrl?: string;
  artifactPath?: string;
  rootCause?: string;
  workingDirectory?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  cause?: string;
  stack?: string;
}

export function normalizeRuntimeError(error: unknown, context: RuntimeErrorContext = {}): RuntimeErrorInfo {
  const value = asRecord(error);
  const causeValue = asRecord(value?.cause);
  const rawCode = stringValue(value?.code) ?? stringValue(causeValue?.code);
  const syscallValue = stringValue(value?.syscall) ?? stringValue(causeValue?.syscall);
  const syscall = syscallValue?.match(/^(spawn|open|stat|read|write|rename|unlink|mkdir|access)\b/iu)?.[1] ?? syscallValue;
  const path = stringValue(value?.path) ?? stringValue(causeValue?.path);
  const rawMessage = error instanceof Error ? error.message : stringValue(value?.message) ?? String(error);
  const rootCause = context.rootCause ?? inferRootCause(rawCode, path, context);
  const code = rawCode === "ENOENT" ? rootCause ?? "file_missing" : rawCode ?? "runtime_error";
  const cause = causeMessage(error);
  const info: RuntimeErrorInfo = {
    code,
    message: rawCode === "ENOENT" ? friendlyMissingMessage(code, path, context) : rawMessage,
    ...(syscall ? { syscall } : {}),
    ...(path ? { path, missingPath: path } : {}),
    ...(context.sourceKey ? { sourceKey: context.sourceKey } : {}),
    ...(context.sourceName ? { sourceName: context.sourceName } : {}),
    ...(context.runtimeKind ? { runtime: context.runtimeKind } : {}),
    ...(context.siteKey ? { siteKey: context.siteKey } : {}),
    ...(context.artifactUrl ? { artifactUrl: context.artifactUrl } : {}),
    ...(context.artifactPath ? { artifactPath: context.artifactPath } : {}),
    ...(rootCause ? { rootCause } : {}),
    ...(context.workingDirectory ? { workingDirectory: context.workingDirectory } : {}),
    ...(context.isPackaged === undefined ? {} : { isPackaged: context.isPackaged }),
    ...(context.resourcesPath ? { resourcesPath: context.resourcesPath } : {}),
    ...(cause ? { cause } : {}),
    ...(context.includeStack !== false && error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };
  return info;
}

export function runtimeErrorMessage(info: RuntimeErrorInfo): string {
  const details = [
    info.rootCause ? `rootCause=${info.rootCause}` : "",
    info.missingPath ? `missingPath=${info.missingPath}` : "",
    info.artifactUrl ? `artifactUrl=${info.artifactUrl}` : "",
    info.siteKey ? `siteKey=${info.siteKey}` : "",
    info.sourceName ? `sourceName=${info.sourceName}` : "",
    info.runtime ? `runtime=${info.runtime}` : "",
  ].filter(Boolean);
  return details.length > 0 ? `${info.message} (${details.join(", ")})` : info.message;
}

function inferRootCause(code: string | undefined, path: string | undefined, context: RuntimeErrorContext): string | undefined {
  if (code !== "ENOENT") return undefined;
  if (context.artifactPath || context.artifactUrl) return "artifact_file_missing";
  const lower = path?.toLowerCase() ?? "";
  if (lower.includes("jvm-spider-host")) return "runtime_host_missing";
  if (lower.includes("worker")) return "worker_file_missing";
  if (lower.includes("python") || lower.includes("mpv") || lower.includes("aria2")) return "runtime_executable_missing";
  return "file_missing";
}

function friendlyMissingMessage(code: string, path: string | undefined, context: RuntimeErrorContext): string {
  const target = path ?? context.artifactPath ?? "required runtime file";
  switch (code) {
    case "artifact_file_missing": return `Spider artifact file is missing: ${target}`;
    case "runtime_host_missing": return `Spider runtime host is missing: ${target}`;
    case "worker_file_missing": return `Spider worker file is missing: ${target}`;
    case "runtime_executable_missing": return `Bundled runtime executable is missing: ${target}`;
    case "relative_url_resolution_failed": return `Relative Spider URL could not be resolved: ${target}`;
    default: return `Required runtime file is missing: ${target}`;
  }
}

function causeMessage(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.cause) return undefined;
  return error.cause instanceof Error ? error.cause.message : String(error.cause);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
