<script setup lang="ts">
import { ref } from "vue";

import type { BackupUiState } from "../../src/backup-types.js";
import ConfirmDialog from "./ConfirmDialog.vue";

const props = defineProps<{
  state: BackupUiState;
  pending: string | null;
}>();

const emit = defineEmits<{
  create: [includeCache: boolean];
  pick: [];
  apply: [];
  clear: [];
  open: [];
}>();

const includeCache = ref(false);
const restoreConfirmOpen = ref(false);

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function confirmRestore(): void {
  restoreConfirmOpen.value = true;
}

function applyRestore(): void {
  restoreConfirmOpen.value = false;
  emit("apply");
}

function labelCompatibility(value: BackupUiState["preview"] extends infer T ? T extends { compatibility: infer C } ? C : never : never): string {
  if (value === "compatible") return "Compatible";
  if (value === "migration-required") return "Migration required";
  return "Newer backup is unsupported";
}
</script>

<template>
  <section class="settings-section backup-restore" data-testid="backup-restore" data-od-id="backup-restore">
    <div>
      <span class="section-kicker">Backup &amp; Restore</span>
      <h2>User data</h2>
      <p class="meta">Exports application data and trusted-source metadata. Login credentials, cookies, active web sessions, and temporary playback secrets are never exported.</p>
    </div>
    <div class="backup-summary">
      <div class="settings-row"><span>Status</span><strong>{{ props.state.status }}</strong></div>
      <div v-if="props.state.lastBackup" class="settings-row"><span>Last backup</span><strong>{{ props.state.lastBackup.fileName }} · {{ formatBytes(props.state.lastBackup.size) }}</strong></div>
      <div v-if="props.state.lastBackup" class="settings-row"><span>Saved records</span><strong>{{ props.state.lastBackup.summary.history }} history · {{ props.state.lastBackup.summary.favorites }} favorites · {{ props.state.lastBackup.summary.following }} following</strong></div>
    </div>
    <div class="button-row backup-actions">
      <label class="settings-control backup-cache-toggle"><span>Include regenerable cache</span><input v-model="includeCache" type="checkbox" :disabled="props.pending !== null" /></label>
      <button type="button" class="button-primary" data-action="backup-create" :disabled="props.pending !== null" @click="emit('create', includeCache)">Create backup</button>
      <button type="button" class="button-secondary" data-action="backup-pick" :disabled="props.pending !== null" @click="emit('pick')">Restore backup</button>
      <button type="button" class="button-secondary" data-action="backup-open" :disabled="props.pending !== null" @click="emit('open')">Open backup folder</button>
    </div>
    <div v-if="props.state.preview" class="backup-preview" data-testid="backup-preview">
      <div class="settings-row"><span>Backup</span><strong>{{ props.state.preview.appVersion }} · {{ props.state.preview.formatVersion }}</strong></div>
      <div class="settings-row"><span>Created</span><strong>{{ props.state.preview.createdAt }}</strong></div>
      <div class="settings-row"><span>Compatibility</span><strong>{{ labelCompatibility(props.state.preview.compatibility) }}</strong></div>
      <div class="settings-row"><span>Records</span><strong>{{ props.state.preview.summary.settings }} settings · {{ props.state.preview.summary.history }} history · {{ props.state.preview.summary.favorites }} favorites · {{ props.state.preview.summary.following }} following · {{ props.state.preview.summary.liveSources }} live · {{ props.state.preview.summary.smartChannels }} smart</strong></div>
      <div class="button-row">
        <button type="button" class="button-primary" data-action="backup-apply" :disabled="props.pending !== null || props.state.preview.compatibility === 'newer-unsupported'" @click="confirmRestore">Replace and restart</button>
        <button type="button" class="button-secondary" data-action="backup-clear" :disabled="props.pending !== null" @click="emit('clear')">Cancel</button>
      </div>
    </div>
    <p v-if="props.state.error" class="error-text">{{ props.state.error.code }}: {{ props.state.error.message }}</p>
  </section>
  <ConfirmDialog
    v-if="restoreConfirmOpen"
    title="Replace current data"
    message="The app will restart after the selected backup replaces the current data."
    confirm-label="Replace and restart"
    danger
    @cancel="restoreConfirmOpen = false"
    @confirm="applyRestore"
  />
</template>
