<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

import { displaySource } from "./safe-display.js";

const props = defineProps<{ open: boolean; warning: string | null; pending: boolean; target?: string }>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const confirmButton = ref<HTMLButtonElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return;
  if (event.key === "Escape") {
    event.preventDefault();
    emit("cancel");
    return;
  }
  if (event.key !== "Tab") return;
  const focusables = [confirmButton.value, cancelButton.value].filter((element): element is HTMLButtonElement => element !== null);
  if (focusables.length === 0) return;
  const current = focusables.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.shiftKey
    ? (current - 1 + focusables.length) % focusables.length
    : (current + 1) % focusables.length;
  event.preventDefault();
  focusables[next]?.focus();
}

watch(() => props.open, (open) => {
  if (open) {
    window.addEventListener("keydown", onKeydown);
    void nextTick(() => confirmButton.value?.focus());
  } else {
    window.removeEventListener("keydown", onKeydown);
  }
}, { immediate: true });

onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div v-if="open" class="dialog-backdrop" data-testid="trust-confirmation-dialog">
    <section class="trust-dialog" role="dialog" aria-modal="true" aria-labelledby="trust-title" data-testid="import-warning" data-od-id="trust-confirmation-dialog">
      <span class="section-kicker">首次使用</span>
      <h2 id="trust-title">确认使用此来源</h2>
      <p>{{ warning || "请确认你已授权使用此配置和媒体来源。" }}</p>
      <p class="meta">来源：{{ displaySource(target || "当前导入配置") }}。确认后，必要的播放请求可能经过本机 LocalProxy。</p>
      <div class="state-actions">
        <button ref="confirmButton" type="button" class="button-primary" data-action="confirm-import" :disabled="pending" @click="emit('confirm')">确认并继续</button>
        <button ref="cancelButton" type="button" class="button-secondary" data-action="cancel-import" :disabled="pending" @click="emit('cancel')">取消</button>
      </div>
    </section>
  </div>
</template>
