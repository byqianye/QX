<script setup lang="ts">
import type { StorageUiState } from "../../src/storage/storage-types.js";

const props = defineProps<{ storage: StorageUiState }>();
const appVersion = "0.1.0";
const runtimeVersions = [
  "Temurin JRE 21.0.7+6",
  "CPython 3.12.10",
  "mpv 2026-08-07",
  "aria2 1.37.0",
];
</script>

<template>
  <section class="settings-section about-panel" data-testid="about-panel" data-od-id="about-panel">
    <div>
      <span class="section-kicker">发行信息</span>
      <h2>关于 QX 影视</h2>
      <p class="meta">只显示可交付的版本与运行时摘要，不显示 token、凭据或完整本地路径。</p>
    </div>
    <span class="status-chip" data-status="success">本地优先</span>
    <div class="settings-row"><span>应用</span><strong>QX 影视</strong></div>
    <div class="settings-row"><span>Version</span><strong class="about-mono">{{ appVersion }}</strong></div>
    <div class="settings-row"><span>Runtime versions</span><strong class="about-runtime-list">{{ runtimeVersions.join(" · ") }}</strong></div>
    <div class="settings-row"><span>License summary</span><strong>GPL / PSF / bundled notices</strong></div>
    <div class="settings-row"><span>Open-source notices</span><strong>随安装包提供 THIRD_PARTY_NOTICES.txt</strong></div>
    <div class="settings-row"><span>Data directory mode</span><strong>{{ props.storage.mode === "portable" ? "Portable" : "Normal" }}</strong></div>
    <p class="meta about-note">更新状态：当前安装包不主动联网检查更新；发布说明与校验文件由发行目录提供。</p>
  </section>
</template>
