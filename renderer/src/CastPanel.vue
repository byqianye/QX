<script setup lang="ts">
import type { CastUiState } from "../../src/cast/cast-types.js";

const props = defineProps<{
  state: CastUiState;
  pending: string | null;
}>();

const emit = defineEmits<{
  discover: [];
  cast: [deviceId: string];
  stop: [];
  disconnect: [];
}>();

const discoveryLabels: Record<CastUiState["discoveryStatus"], string> = {
  idle: "Ready",
  searching: "Searching",
  ready: "Devices",
  error: "Error",
};

const sessionLabels: Record<NonNullable<CastUiState["session"]>["state"], string> = {
  connecting: "Connecting",
  playing: "Playing",
  paused: "Paused",
  stopped: "Stopped",
  error: "Error",
};
</script>

<template>
  <section class="panel cast-panel" data-testid="cast-panel">
    <div class="section-heading">
      <div>
        <span class="section-kicker">DLNA / UPnP</span>
        <h3>Cast</h3>
      </div>
      <button
        type="button"
        class="button-secondary"
        data-action="cast-discover"
        :disabled="props.pending === 'cast-discover' || props.state.discoveryStatus === 'searching'"
        @click="emit('discover')"
      >
        {{ props.state.discoveryStatus === 'searching' ? 'Searching…' : 'Search devices' }}
      </button>
    </div>
    <p class="meta" data-testid="cast-discovery-status">{{ discoveryLabels[props.state.discoveryStatus] }}</p>
    <p v-if="props.state.error" class="error-text" data-testid="cast-error">{{ props.state.error.code }} · {{ props.state.error.message }}</p>
    <div v-if="props.state.devices.length > 0" class="cast-device-list" data-testid="cast-devices">
      <button
        v-for="device in props.state.devices"
        :key="device.deviceId"
        type="button"
        class="settings-row cast-device"
        :data-action="`cast-device-${device.deviceId}`"
        @click="emit('cast', device.deviceId)"
      >
        <span>
          <strong>{{ device.friendlyName }}</strong>
          <small>{{ device.manufacturer }} · {{ device.model }}</small>
        </span>
        <span class="status-chip">{{ props.state.session?.device.deviceId === device.deviceId ? 'Connected' : 'Cast' }}</span>
      </button>
    </div>
    <div v-else-if="props.state.discoveryStatus === 'ready'" class="empty-state">No MediaRenderer found.</div>
    <div v-if="props.state.session" class="cast-session" data-testid="cast-session">
      <div class="settings-row">
        <span>Connected</span>
        <strong>{{ props.state.session.device.friendlyName }} · {{ sessionLabels[props.state.session.state] }}</strong>
      </div>
      <p class="meta">{{ props.state.session.media.title }} · {{ Math.floor(props.state.session.lastPosition) }}s</p>
      <p v-if="props.state.session.error" class="error-text">{{ props.state.session.error.code }} · {{ props.state.session.error.message }}</p>
      <div class="button-row">
        <button type="button" class="button-secondary" data-action="cast-stop" @click="emit('stop')">Stop</button>
        <button type="button" class="text-button" data-action="cast-disconnect" @click="emit('disconnect')">Disconnect</button>
      </div>
    </div>
  </section>
</template>
