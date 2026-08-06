export type QuickJsEngineErrorCode =
  | "QUICKJS_SCRIPT_LOAD_FAILED"
  | "QUICKJS_SCRIPT_ERROR"
  | "QUICKJS_TIMEOUT"
  | "QUICKJS_MEMORY_LIMIT"
  | "QUICKJS_NETWORK_DENIED"
  | "QUICKJS_NETWORK_ERROR"
  | "QUICKJS_RESPONSE_TOO_LARGE"
  | "QUICKJS_UNSUPPORTED_METHOD"
  | "QUICKJS_DESTROYED"
  | "QUICKJS_NOT_INITIALIZED";

export class QuickJsEngineError extends Error {
  public readonly code: QuickJsEngineErrorCode;

  public constructor(
    code: QuickJsEngineErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "QuickJsEngineError";
    this.code = code;
  }
}
