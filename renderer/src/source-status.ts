import type { AppErrorSource, SpiderStatus } from "./state.js";

export type SourceDisplayStatus = "ready" | "error" | "unknown";

const SOURCE_ERROR_SOURCES: readonly AppErrorSource[] = ["rpc", "source", "spider"];

export function sourceDisplayStatus(input: {
  sessionReady: boolean;
  spiderStatus: SpiderStatus;
  errorSource?: AppErrorSource;
}): SourceDisplayStatus {
  if (input.spiderStatus === "error" || (input.errorSource !== undefined && SOURCE_ERROR_SOURCES.includes(input.errorSource))) {
    return "error";
  }
  if (input.sessionReady) return "ready";
  return "unknown";
}

export function sourceDisplayLabel(status: SourceDisplayStatus): string {
  return status === "ready" ? "已连接" : status === "error" ? "不可用" : "未检测";
}
