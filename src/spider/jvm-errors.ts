export type JvmEngineErrorCode =
  | "ANDROID_DEX_UNSUPPORTED"
  | "JVM_ARTIFACT_NOT_FOUND"
  | "JVM_ARTIFACT_INVALID"
  | "JVM_SIDECAR_START_FAILED"
  | "JVM_SIDECAR_CRASHED"
  | "JVM_SIDECAR_PROTOCOL_ERROR"
  | "JVM_SIDECAR_DESTROYED"
  | "JVM_SPIDER_TIMEOUT"
  | "JVM_SPIDER_NOT_INITIALIZED";

export class JvmEngineError extends Error {
  public readonly code: JvmEngineErrorCode;

  public constructor(code: JvmEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JvmEngineError";
    this.code = code;
  }
}

export class JvmSidecarTimeoutError extends JvmEngineError {
  public constructor(method: string) {
    super("JVM_SPIDER_TIMEOUT", `JVM sidecar request timeout: ${method}`);
    this.name = "JvmSidecarTimeoutError";
  }
}
