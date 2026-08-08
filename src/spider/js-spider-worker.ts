import { parentPort } from "node:worker_threads";

import { QuickJsMediaSource } from "./quickjs-source.js";
import type { SourceCapabilities, SourceInitContext } from "../source/media-source.js";

interface WorkerOptions {
  script: string;
  scriptName?: string;
  moduleSources?: Readonly<Record<string, string>>;
  allowedOrigins?: readonly string[];
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  maxExecutionMs?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  maxScriptBytes?: number;
  maxModules?: number;
}

interface WorkerMessage {
  id: number;
  operation: string;
  args?: unknown[];
}

let source: QuickJsMediaSource | undefined;

parentPort?.on("message", (message: WorkerMessage) => {
  void handle(message);
});

async function handle(message: WorkerMessage): Promise<void> {
  try {
    if (message.operation === "create") {
      source = new QuickJsMediaSource({ api: "js:worker", ...(message.args?.[0] as WorkerOptions) });
      await source.init(contextOf(message.args?.[1]));
      reply(message.id, { capabilities: source.capabilities });
      return;
    }
    if (!source) throw codedError("JS_WORKER_NOT_INITIALIZED", "JavaScript Spider worker is not initialized");
    if (message.operation === "home") {
      reply(message.id, await source.home());
    } else if (message.operation === "category") {
      reply(message.id, await source.category(message.args?.[0] as Parameters<QuickJsMediaSource["category"]>[0]));
    } else if (message.operation === "search") {
      reply(message.id, await source.search(message.args?.[0] as Parameters<QuickJsMediaSource["search"]>[0]));
    } else if (message.operation === "detail") {
      reply(message.id, await source.detail(message.args?.[0] as string[]));
    } else if (message.operation === "player") {
      reply(message.id, await source.player(message.args?.[0] as Parameters<QuickJsMediaSource["player"]>[0]));
    } else if (message.operation === "destroy") {
      await source.destroy();
      source = undefined;
      reply(message.id, { destroyed: true });
    } else {
      throw codedError("JS_WORKER_OPERATION_UNSUPPORTED", `Unsupported JavaScript Spider operation: ${message.operation}`);
    }
  } catch (error) {
    replyError(message.id, error);
  }
}

function contextOf(value: unknown): SourceInitContext {
  if (isRecord(value)) return value as unknown as SourceInitContext;
  return { sourceId: "js-worker" };
}

function reply(id: number, value: unknown): void {
  parentPort?.postMessage({ id, ok: true, value });
}

function replyError(id: number, error: unknown): void {
  const candidate = error as { code?: unknown };
  parentPort?.postMessage({
    id,
    ok: false,
    code: typeof candidate?.code === "string" ? candidate.code : "JS_WORKER_ERROR",
    message: error instanceof Error ? error.message : String(error),
  });
}

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { SourceCapabilities };
