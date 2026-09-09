import type { RendererEnvelope } from "./state.js";

export interface RendererRequestOptions {
  signal?: AbortSignal;
  onProgress?: (envelope: RendererEnvelope) => void;
}

export function isRequestCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** A bounded operation, shared by transport, progress and final-state commits. */
export class RequestTask {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly unlink: () => void;

  constructor(timeoutMs: number, parent?: AbortSignal) {
    this.deadline = performance.now() + timeoutMs;
    this.timer = setTimeout(() => this.cancel(new Error("SOURCE_OPERATION_TIMEOUT")), timeoutMs);
    const abort = () => this.cancel(parent?.reason);
    parent?.addEventListener("abort", abort, { once: true });
    this.unlink = () => parent?.removeEventListener("abort", abort);
    if (parent?.aborted) abort();
  }

  remainingMs(): number { this.check(); return Math.max(1, Math.ceil(this.deadline - performance.now())); }
  check(): void { if (this.signal.aborted) throw this.signal.reason; }
  cancel(reason: unknown = new DOMException("Request cancelled", "AbortError")): void { this.controller.abort(reason); }
  dispose(): void { clearTimeout(this.timer); this.unlink(); }

  async wait<T>(promise: Promise<T>): Promise<T> {
    // Attach rejection handling even when cancellation wins before this call.
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", abort, { once: true });
      promise.then(value => this.signal.aborted ? reject(this.signal.reason) : resolve(value), reject)
        .finally(() => this.signal.removeEventListener("abort", abort));
      if (this.signal.aborted) abort();
    });
  }
}
