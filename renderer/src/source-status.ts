import type { AppErrorSource, ImportStatus, SpiderStatus } from "./state.js";

export type SourceDisplayStatus = "ready" | "error" | "initializing" | "checking" | "unknown";

const SOURCE_ERROR_SOURCES: readonly AppErrorSource[] = ["rpc", "source", "spider"];

export function sourceDisplayStatus(input: {
  sessionReady: boolean;
  spiderStatus: SpiderStatus;
  importStatus?: ImportStatus;
  errorSource?: AppErrorSource;
}): SourceDisplayStatus {
  if (input.spiderStatus === "error" || (input.errorSource !== undefined && SOURCE_ERROR_SOURCES.includes(input.errorSource))) {
    return "error";
  }
  if (input.sessionReady) return "ready";
  if (input.spiderStatus === "initializing" || input.spiderStatus === "confirmation_required" || input.importStatus === "loading") {
    return "initializing";
  }
  if (input.spiderStatus === "loading") return "checking";
  return "unknown";
}

export function sourceDisplayLabel(status: SourceDisplayStatus): string {
  if (status === "ready") return "已连接";
  if (status === "error") return "不可用";
  if (status === "initializing") return "准备中";
  if (status === "checking") return "检测中";
  return "未检测";
}
