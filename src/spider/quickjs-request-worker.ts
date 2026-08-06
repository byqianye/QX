import { parentPort, workerData } from "node:worker_threads";

interface RequestWorkerData {
  control: SharedArrayBuffer;
  payload: SharedArrayBuffer;
  maxResponseBytes: number;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
  };
}

interface WorkerResponse {
  ok: true;
  value: {
    url: string;
    status: number;
    headers: Record<string, string>;
    body: string;
  };
}

interface WorkerErrorResponse {
  ok: false;
  code: string;
  message: string;
}

void run(workerData as RequestWorkerData);

async function run(data: RequestWorkerData): Promise<void> {
  const control = new Int32Array(data.control);
  const payload = new Uint8Array(data.payload);
  try {
    const response = await fetchResponse(data);
    writePayload(control, payload, {
      ok: true,
      value: response,
    });
  } catch (error) {
    const candidate = error as Error & { code?: unknown };
    writePayload(control, payload, {
      ok: false,
      code: typeof candidate.code === "string" ? candidate.code : "QUICKJS_NETWORK_ERROR",
      message: candidate.message ?? String(error),
    });
  }
}

async function fetchResponse(data: RequestWorkerData): Promise<WorkerResponse["value"]> {
  const timeoutMs = Math.max(1, Math.floor(data.request.timeoutMs));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(data.request.url, {
      method: data.request.method,
      headers: data.request.headers,
      ...(data.request.body === undefined ? {} : { body: data.request.body }),
      signal: controller.signal,
    });
    const body = await readBody(response, data.maxResponseBytes);
    return {
      url: response.url || data.request.url,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`QuickJS request timeout: ${data.request.url}`);
      (timeoutError as Error & { code: string }).code = "QUICKJS_NETWORK_ERROR";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readBody(response: Response, maxResponseBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxResponseBytes) {
        const sizeError = new Error(`QuickJS response exceeds ${maxResponseBytes} bytes`);
        (sizeError as Error & { code: string }).code = "QUICKJS_RESPONSE_TOO_LARGE";
        await reader.cancel(sizeError);
        throw sizeError;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function writePayload(control: Int32Array, payload: Uint8Array, value: WorkerResponse | WorkerErrorResponse): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const length = Math.min(bytes.byteLength, payload.byteLength);
  payload.fill(0);
  payload.set(bytes.subarray(0, length));
  Atomics.store(control, 1, length);
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
}
