import { Worker } from "node:worker_threads";

import { QuickJsEngineError } from "./quickjs-errors.js";

export interface QuickJsRequest {
  url: string;
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  timeoutMs?: number;
}

export interface QuickJsHttpResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface QuickJsNormalizedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export type QuickJsRequestHandler = (request: QuickJsNormalizedRequest) => QuickJsHttpResponse;

export interface QuickJsRequestOptions {
  maxResponseBytes: number;
  request?: QuickJsRequestHandler;
}

interface WorkerResponse {
  ok: true;
  value: QuickJsHttpResponse;
}

interface WorkerErrorResponse {
  ok: false;
  code: string;
  message: string;
}

export function requestQuickJsSync(
  request: QuickJsNormalizedRequest,
  options: QuickJsRequestOptions,
): QuickJsHttpResponse {
  if (options.request) return limitResponse(options.request(request), options.maxResponseBytes);

  const maxResponseBytes = Math.max(1, Math.floor(options.maxResponseBytes));
  const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const payload = new SharedArrayBuffer(maxResponseBytes + 512 * 1024);
  const worker = new Worker(new URL("./quickjs-request-worker.js", import.meta.url), {
    workerData: {
      control,
      payload,
      maxResponseBytes,
      request,
    },
  });

  try {
    const waitResult = Atomics.wait(
      new Int32Array(control),
      0,
      0,
      Math.max(1, request.timeoutMs) + 250,
    );
    const controlView = new Int32Array(control);
    if (Atomics.load(controlView, 0) !== 1) {
      throw new QuickJsEngineError(
        "QUICKJS_NETWORK_ERROR",
        waitResult === "timed-out"
          ? `QuickJS request timeout: ${request.url}`
          : `QuickJS request worker stopped before returning a response: ${request.url}`,
      );
    }

    const length = Atomics.load(controlView, 1);
    const raw = new TextDecoder().decode(new Uint8Array(payload, 0, length));
    let value: WorkerResponse | WorkerErrorResponse;
    try {
      value = JSON.parse(raw) as WorkerResponse | WorkerErrorResponse;
    } catch (error) {
      throw new QuickJsEngineError(
        "QUICKJS_NETWORK_ERROR",
        "QuickJS request worker returned invalid data",
        { cause: error },
      );
    }
    if (!value.ok) {
      throw new QuickJsEngineError(
        toRequestErrorCode(value.code),
        value.message,
      );
    }
    return limitResponse(value.value, maxResponseBytes);
  } finally {
    void worker.terminate();
  }
}

function limitResponse(response: QuickJsHttpResponse, maxResponseBytes: number): QuickJsHttpResponse {
  const bodyBytes = new TextEncoder().encode(response.body);
  if (bodyBytes.byteLength > maxResponseBytes) {
    throw new QuickJsEngineError(
      "QUICKJS_RESPONSE_TOO_LARGE",
      `QuickJS response exceeds ${maxResponseBytes} bytes`,
    );
  }
  return {
    url: response.url,
    status: response.status,
    headers: { ...response.headers },
    body: response.body,
  };
}

function toRequestErrorCode(code: string): "QUICKJS_NETWORK_ERROR" | "QUICKJS_RESPONSE_TOO_LARGE" {
  return code === "QUICKJS_RESPONSE_TOO_LARGE"
    ? "QUICKJS_RESPONSE_TOO_LARGE"
    : "QUICKJS_NETWORK_ERROR";
}
