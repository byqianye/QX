<script setup lang="ts">
import { ref, watch } from "vue";

import type { PushConfirmationPolicy, PushConflictMode, PushUiState } from "../../src/push/push-types.js";

const props = defineProps<{
  state: PushUiState;
  pending: string | null;
}>();

const emit = defineEmits<{
  settings: [patch: { enabled: boolean; port: number; confirmationPolicy: PushConfirmationPolicy; conflictMode: PushConflictMode }];
  confirm: [id: string];
  reject: [id: string];
  cancel: [id: string];
  clear: [];
}>();

const enabled = ref(props.state.enabled);
const port = ref(props.state.configuredPort);
const confirmationPolicy = ref<PushConfirmationPolicy>(props.state.confirmationPolicy);
const conflictMode = ref<PushConflictMode>(props.state.conflictMode);

watch(() => props.state, (state) => {
  enabled.value = state.enabled;
  port.value = state.configuredPort;
  confirmationPolicy.value = state.confirmationPolicy;
  conflictMode.value = state.conflictMode;
}, { deep: true });

function save(): void {
  emit("settings", {
    enabled: enabled.value,
    port: Number.isInteger(port.value) && port.value >= 0 ? port.value : 0,
    confirmationPolicy: confirmationPolicy.value,
    conflictMode: conflictMode.value,
  });
}
</script>

<template>
  <section class="settings-section push-settings" data-testid="push-settings">
    <div>
      <span class="section-kicker">localhost only</span>
      <h2>Push / 投送</h2>
      <p class="meta">外部请求只能进入本机回环地址；未知 Push 默认需要确认，不会看到完整地址或请求头。</p>
    </div>

    <div class="settings-row">
      <div>
        <span>服务状态</span>
        <strong>{{ props.state.listening ? `监听 ${props.state.port}` : (props.state.enabled ? "等待启动" : "已关闭") }}</strong>
      </div>
      <span class="status-chip" :data-status="props.state.error ? 'error' : (props.state.listening ? 'ready' : 'warning')">
        {{ props.state.error ? props.state.error.code : (props.state.listening ? "已启用" : "未监听") }}
      </span>
    </div>

    <div v-if="props.state.endpoint" class="settings-row">
      <span>本机 Endpoint</span>
      <code>{{ props.state.endpoint }}</code>
    </div>

    <label class="settings-control">
      <span>Enable localhost push</span>
      <input v-model="enabled" type="checkbox" data-action="push-enabled" />
    </label>
    <label class="settings-control">
      <span>Port（0 = 随机）</span>
      <input v-model.number="port" type="number" min="0" max="65535" inputmode="numeric" data-action="push-port" />
    </label>
    <label class="settings-control">
      <span>Confirmation policy</span>
      <select v-model="confirmationPolicy" data-action="push-confirmation-policy">
        <option value="ask">Ask</option>
        <option value="allow-trusted-local">Allow trusted local apps</option>
      </select>
    </label>
    <label class="settings-control">
      <span>冲突策略</span>
      <select v-model="conflictMode" data-action="push-conflict-mode">
        <option value="replace">Replace</option>
        <option value="queue">Queue</option>
        <option value="reject">Reject</option>
      </select>
    </label>
    <button type="button" class="button-primary" data-action="push-save" :disabled="props.pending !== null" @click="save">保存 Push 设置</button>

    <div v-if="props.state.pending.length > 0" class="push-pending-list" data-testid="push-pending-list">
      <div class="settings-row"><strong>待确认</strong><span class="meta">Play / Reject</span></div>
      <article v-for="item in props.state.pending" :key="item.id" class="settings-row">
        <div>
          <strong>{{ item.title }}</strong>
          <span class="meta">{{ item.type }} · {{ item.requestedBy }}{{ item.targetHost ? ` · ${item.targetHost}` : "" }}</span>
        </div>
        <div class="button-row">
          <button type="button" class="button-primary" :data-action="`push-confirm-${item.id}`" :disabled="props.pending !== null" @click="emit('confirm', item.id)">Play</button>
          <button type="button" class="button-secondary" :data-action="`push-reject-${item.id}`" :disabled="props.pending !== null" @click="emit('reject', item.id)">Reject</button>
          <button type="button" class="text-button" :data-action="`push-cancel-${item.id}`" :disabled="props.pending !== null" @click="emit('cancel', item.id)">取消</button>
        </div>
      </article>
    </div>

    <div class="settings-row">
      <div>
        <span>最近 Push</span>
        <strong>{{ props.state.recent.length }} 条</strong>
      </div>
      <button type="button" class="button-secondary" data-action="push-clear" :disabled="props.pending !== null || props.state.recent.length === 0" @click="emit('clear')">Clear</button>
    </div>
    <div v-if="props.state.recent.length > 0" class="push-recent-list" data-testid="push-recent-list">
      <div v-for="item in props.state.recent" :key="item.id" class="settings-row">
        <div>
          <strong>{{ item.title }}</strong>
          <span class="meta">{{ item.type }} · {{ item.requestedBy }} · {{ item.status }}</span>
          <span v-if="item.error" class="meta">{{ item.error.code }} · {{ item.error.message }}</span>
        </div>
      </div>
    </div>
    <p class="meta">LAN 控制：Requires G68 LAN Control。</p>
  </section>
</template>
