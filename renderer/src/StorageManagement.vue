<script setup lang="ts">
import { ref } from "vue";

import type { StorageMode, StorageUiState } from "../../src/storage/storage-types.js";
import ConfirmDialog from "./ConfirmDialog.vue";

const props = defineProps<{
  state: StorageUiState;
  pending: string | null;
}>();

const emit = defineEmits<{
  refresh: [];
  open: [];
  switch: [mode: StorageMode];
}>();
const pendingMode = ref<StorageMode | null>(null);

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function requestSwitch(mode: StorageMode): void {
  if (mode === props.state.mode) return;
  pendingMode.value = mode;
}

function confirmSwitch(): void {
  const mode = pendingMode.value;
  pendingMode.value = null;
  if (!mode) return;
  emit("switch", mode);
}
</script>

<template>
  <section class="settings-section storage-management" data-testid="storage-management" data-od-id="storage-management">
    <div>
      <span class="section-kicker">Storage / Portable</span>
      <h2>Data directory</h2>
      <p class="meta">Switching copies the database and regenerable folders, validates the copy, and keeps the old data as a backup.</p>
    </div>
    <div class="storage-summary" data-testid="storage-summary">
      <div class="settings-row"><span>Mode</span><strong data-testid="storage-mode">{{ props.state.mode }}</strong></div>
      <div class="settings-row"><span>Current root</span><strong data-testid="storage-root">{{ props.state.dataRoot }}</strong></div>
      <div class="settings-row"><span>Normal target</span><strong>{{ props.state.normalRoot }}</strong></div>
      <div class="settings-row"><span>Portable target</span><strong>{{ props.state.portableRoot }}</strong></div>
      <div class="settings-row"><span>Database</span><strong>{{ formatBytes(props.state.databaseBytes) }}</strong></div>
      <div class="settings-row"><span>Cache</span><strong>{{ formatBytes(props.state.cacheBytes) }}</strong></div>
      <div class="settings-row"><span>Total</span><strong>{{ formatBytes(props.state.totalBytes) }}</strong></div>
      <div class="settings-row"><span>History / Favorites / Following</span><strong>{{ props.state.historyCount }} / {{ props.state.favoritesCount }} / {{ props.state.followCount }}</strong></div>
      <div class="settings-row"><span>Access</span><strong>{{ props.state.writable ? "Writable" : (props.state.error ?? "Unavailable") }}</strong></div>
    </div>
    <div class="button-row storage-actions">
      <button type="button" class="button-secondary" data-action="storage-refresh" :disabled="props.pending !== null" @click="emit('refresh')">Refresh</button>
      <button type="button" class="button-secondary" data-action="storage-open" :disabled="props.pending !== null" @click="emit('open')">Open data folder</button>
      <button type="button" class="button-secondary" data-action="storage-switch-normal" :disabled="props.pending !== null || props.state.mode === 'normal'" @click="requestSwitch('normal')">Use normal mode</button>
      <button type="button" class="button-primary" data-action="storage-switch-portable" :disabled="props.pending !== null || props.state.mode === 'portable'" @click="requestSwitch('portable')">Use portable mode</button>
    </div>
  </section>
  <ConfirmDialog
    v-if="pendingMode"
    title="Switch data directory mode"
    :message="`Switch to ${pendingMode} mode? The app will restart after migration.`"
    confirm-label="Switch and restart"
    @cancel="pendingMode = null"
    @confirm="confirmSwitch"
  />
</template>
