<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import SettingsSection from "./SettingsSection.vue";

interface AndroidRuntimeStatus {
  adbFound: boolean;
  deviceFound: boolean;
  deviceSerial?: string;
  deviceStatus: "online" | "offline" | "missing";
  hostApkFound: boolean;
  hostStatus: "online" | "offline" | "missing";
  diagnostics: readonly string[];
  message: string;
  bootstrapState?: string;
  supervisorState?: string;
  consentRequired?: boolean;
  runtimeVersion?: string;
  hostVersion?: string;
  androidApi?: number;
  architecture?: string;
  avdName?: string;
  estimatedDownload?: string;
  mode?: "auto" | "resident" | "disabled";
  whpx?: "ready" | "missing" | "unknown";
  diskUsageBytes?: number;
  runtimeRoot?: string;
  progress?: {
    stage: string;
    downloadedBytes?: number;
    totalBytes?: number;
    speedBytesPerSecond?: number;
    remainingSeconds?: number;
    message?: string;
    cancellable: boolean;
  };
}

const status = ref<AndroidRuntimeStatus | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const actionError = ref<string | null>(null);
type ConfirmAction = "enable" | "enableWhpx" | "repair" | "reinstall" | "uninstall";
const pendingConfirm = ref<{ action: ConfirmAction; title: string; message: string; danger?: boolean } | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

function hostStatusLabel(value: AndroidRuntimeStatus["hostStatus"] | undefined): string {
  return value === "online" ? "已连接" : value === "offline" ? "暂不可用" : "未安装";
}

function whpxLabel(value: AndroidRuntimeStatus["whpx"] | undefined): string {
  return value === "ready" ? "可用" : value === "missing" ? "未启用" : "检查中";
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || value <= 0) return "—";
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(0)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function friendlyMessage(value: string | undefined): string {
  if (!value) return "正在检查 Android Runtime…";
  if (value.includes("INSUFFICIENT_DISK_SPACE")) return "磁盘空间不足，请清理空间后重试。";
  if (value.includes("WHPX") || value.includes("VIRTUALIZATION")) return "当前 Windows 虚拟化环境不可用，请启用 WHPX 或 BIOS 虚拟化后重试。";
  if (value.includes("DOWNLOAD")) return "Runtime 下载失败，请检查网络后重试。";
  if (value.includes("LICENSE")) return "Android SDK 许可处理失败，请重试并完成官方许可确认。";
  if (value.includes("CANCELLED")) return "Runtime 安装已取消。";
  if (value.includes("REPAIR")) return "Runtime 文件需要修复。";
  return value;
}

function progressPercent(): number | null {
  const progress = status.value?.progress;
  if (!progress?.totalBytes || progress.totalBytes <= 0 || progress.downloadedBytes === undefined) return null;
  return Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100));
}

async function refresh(): Promise<void> {
  try {
    const response = await fetch("/api/android/runtime/status");
    if (!response.ok) throw new Error("ANDROID_RUNTIME_STATUS_UNAVAILABLE");
    status.value = await response.json() as AndroidRuntimeStatus;
  } catch {
    error.value = "Android Spider Runtime 状态暂不可用";
  }
}

function requestConfirmation(action: ConfirmAction, title: string, message: string, danger = false): void {
  pendingConfirm.value = { action, title, message, ...(danger ? { danger: true } : {}) };
}

async function confirmAction(): Promise<void> {
  const action = pendingConfirm.value?.action;
  pendingConfirm.value = null;
  if (!action) return;
  if (action === "enable") await runEnable();
  else if (action === "enableWhpx") await runEnableWhpx();
  else if (action === "repair") await runRepair();
  else if (action === "reinstall") await runReinstall();
  else await runUninstall();
}

async function runEnable(): Promise<void> {
  busy.value = true;
  actionError.value = null;
  try {
    const response = await fetch("/api/android/runtime/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    if (!response.ok) throw new Error("ANDROID_RUNTIME_ENABLE_FAILED");
  } catch {
    actionError.value = "Android 兼容运行环境安装失败，请检查网络、磁盘空间和 WHPX。";
  } finally {
    busy.value = false;
    await refresh();
  }
}

async function restart(): Promise<void> {
  busy.value = true;
  actionError.value = null;
  try {
    const response = await fetch("/api/android/runtime/restart", { method: "POST", body: "{}" });
    if (!response.ok) throw new Error("ANDROID_RUNTIME_RESTART_FAILED");
  } catch {
    actionError.value = "Android 兼容运行环境重启失败。";
  } finally {
    busy.value = false;
    await refresh();
  }
}

async function runEnableWhpx(): Promise<void> {
  busy.value = true;
  actionError.value = null;
  try {
    const response = await fetch("/api/android/runtime/enable-whpx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    if (!response.ok) throw new Error("WHPX_ENABLE_FAILED");
  } catch {
    actionError.value = "WHPX 启用失败，可能需要手动开启 Windows 功能或重启系统。";
  } finally {
    busy.value = false;
    await refresh();
  }
}

async function changeMode(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value;
  if (value !== "auto" && value !== "resident" && value !== "disabled") return;
  try {
    const response = await fetch("/api/android/runtime/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: value }),
    });
    if (!response.ok) throw new Error("ANDROID_RUNTIME_MODE_FAILED");
    await refresh();
  } catch {
    actionError.value = "Android Runtime 模式切换失败。";
  }
}

async function runRepair(): Promise<void> {
  busy.value = true;
  actionError.value = null;
  try {
    const response = await fetch("/api/android/runtime/repair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    if (!response.ok) throw new Error("ANDROID_RUNTIME_REPAIR_FAILED");
  } catch {
    actionError.value = "Android 兼容运行环境修复失败。";
  } finally {
    busy.value = false;
    await refresh();
  }
}

async function runReinstall(): Promise<void> {
  busy.value = true;
  actionError.value = null;
  try {
    const response = await fetch("/api/android/runtime/reinstall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    if (!response.ok) throw new Error("ANDROID_RUNTIME_REINSTALL_FAILED");
  } catch {
    actionError.value = "Android 兼容运行环境重新安装失败。";
  } finally {
    busy.value = false;
    await refresh();
  }
}

async function runUninstall(): Promise<void> {
  busy.value = true;
  actionError.value = null;
  try {
    const response = await fetch("/api/android/runtime/uninstall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    if (!response.ok) throw new Error("ANDROID_RUNTIME_UNINSTALL_FAILED");
  } catch {
    actionError.value = "Android 兼容运行环境卸载失败。";
  } finally {
    busy.value = false;
    await refresh();
  }
}

async function cancel(): Promise<void> {
  try {
    await fetch("/api/android/runtime/cancel", { method: "POST", body: "{}" });
  } finally {
    busy.value = false;
    await refresh();
  }
}

onMounted(async () => {
  await refresh();
  timer = setInterval(() => { void refresh(); }, 2_000);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <SettingsSection title="Android 兼容运行环境" description="Android DEX 来源按需使用独立的隐藏模拟器，不需要 Android Studio、Java、ADB 或 Android 手机。">
    <div v-if="error" class="settings-row"><span>状态</span><strong>{{ error }}</strong></div>
    <template v-else-if="status">
      <div class="settings-row"><span>状态</span><strong data-testid="android-runtime-status">{{ friendlyMessage(status.message) }}</strong></div>
      <div class="settings-row"><span>Runtime / Android / Host / WHPX</span><strong>{{ status.runtimeVersion ?? "—" }} / API {{ status.androidApi ?? "—" }} / {{ status.hostVersion ?? "—" }} / {{ whpxLabel(status.whpx) }}</strong></div>
      <div class="settings-row"><span>Android Host RPC</span><strong :data-status="status.hostStatus">{{ hostStatusLabel(status.hostStatus) }}</strong></div>
      <label class="settings-control"><span>运行模式</span><select :value="status.mode ?? 'auto'" aria-label="Android Runtime 运行模式" @change="changeMode"><option value="auto">自动</option><option value="resident">常驻</option><option value="disabled">禁用</option></select></label>
      <div class="settings-row"><span>磁盘占用</span><strong>{{ formatBytes(status.diskUsageBytes) }}</strong></div>
      <div v-if="status.runtimeRoot" class="meta">安装位置：{{ status.runtimeRoot }}</div>
      <div v-if="status.estimatedDownload && status.consentRequired" class="meta">首次安装预计下载 {{ status.estimatedDownload }}；组件来自 Android 官方源。</div>
      <div v-if="status.progress && status.progress.stage !== 'idle'" class="meta">
        {{ status.progress.message ?? friendlyMessage(status.message) }}
        <span v-if="progressPercent() !== null">{{ progressPercent() }}%</span>
        <span v-if="status.progress.speedBytesPerSecond"> · {{ formatBytes(status.progress.speedBytesPerSecond) }}/秒</span>
        <span v-if="status.progress.remainingSeconds"> · 剩余约 {{ Math.ceil(status.progress.remainingSeconds) }} 秒</span>
      </div>
      <div v-if="actionError" class="meta">{{ actionError }}</div>
      <div class="settings-actions">
        <button v-if="busy && status.progress?.cancellable" type="button" class="button-secondary" @click="cancel">取消安装</button>
        <button v-if="status.whpx === 'missing'" type="button" class="button-secondary" :disabled="busy" @click="requestConfirmation('enableWhpx', '启用 Windows Hypervisor Platform', 'QX 将请求管理员权限，完成后可能需要重启 Windows。')">启用 WHPX</button>
        <button v-if="status.mode !== 'disabled' && (status.consentRequired || status.supervisorState === 'DEGRADED' || status.bootstrapState === 'REPAIR_AVAILABLE')" type="button" class="button-secondary" :disabled="busy" @click="status.consentRequired ? requestConfirmation('enable', '安装 Android 兼容运行环境', `将从官方源下载 ${status.estimatedDownload ?? '若干 GB'}，并接受 Android SDK 许可协议。`) : requestConfirmation('repair', '修复 Android Runtime', '将检查并修复 Android Runtime 文件、AVD 和 Host。')">
          {{ busy ? "处理中…" : status.consentRequired ? "安装并启用" : "修复运行环境" }}
        </button>
        <button v-if="status.supervisorState === 'READY'" type="button" class="button-secondary" :disabled="busy" @click="restart">重新启动</button>
        <button v-if="status.bootstrapState === 'READY' || status.bootstrapState === 'REPAIR_AVAILABLE'" type="button" class="button-secondary" :disabled="busy" @click="requestConfirmation('reinstall', '重新安装 Android Runtime', '将删除独立 Android Runtime 后重新下载全部组件。')">重新安装</button>
        <button v-if="status.bootstrapState === 'READY' || status.bootstrapState === 'REPAIR_AVAILABLE'" type="button" class="button-secondary" :disabled="busy" @click="requestConfirmation('uninstall', '卸载 Android Runtime', '将删除 QX 独立 Android Runtime（约数 GB），不会删除你的来源配置。', true)">卸载运行环境</button>
      </div>
    </template>
    <div v-else class="settings-row"><span>状态</span><strong>正在检查…</strong></div>
  </SettingsSection>
  <ConfirmDialog
    v-if="pendingConfirm"
    :title="pendingConfirm.title"
    :message="pendingConfirm.message"
    :danger="pendingConfirm.danger"
    @cancel="pendingConfirm = null"
    @confirm="confirmAction"
  />
</template>
