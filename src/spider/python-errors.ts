export type PythonEngineErrorCode =
  | "PYTHON_NOT_FOUND"
  | "PYTHON_SCRIPT_NOT_FOUND"
  | "PYTHON_START_FAILED"
  | "PYTHON_CRASHED"
  | "PYTHON_PROTOCOL_ERROR"
  | "PYTHON_TIMEOUT"
  | "PYTHON_DESTROYED"
  | "PYTHON_NOT_INITIALIZED"
  | "PYTHON_SPIDER_ERROR";

export class PythonEngineError extends Error {
  public readonly code: PythonEngineErrorCode;

  public constructor(code: PythonEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PythonEngineError";
    this.code = code;
  }
}
