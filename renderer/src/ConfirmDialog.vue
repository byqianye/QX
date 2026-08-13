<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

const props = withDefaults(defineProps<{
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}>(), {
  confirmLabel: "继续",
  cancelLabel: "取消",
  danger: false,
});

const emit = defineEmits<{ confirm: []; cancel: [] }>();
const dialog = ref<HTMLElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
let previousFocus: HTMLElement | null = null;

function focusableElements(): HTMLElement[] {
  return Array.from(dialog.value?.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ) ?? []);
}

onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  void nextTick(() => cancelButton.value?.focus());
});

onBeforeUnmount(() => {
  if (previousFocus?.isConnected) previousFocus.focus();
});

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("cancel");
    return;
  }
  if (event.key !== "Tab") return;
  const elements = focusableElements();
  if (elements.length === 0) {
    event.preventDefault();
    dialog.value?.focus();
    return;
  }
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<template>
  <div class="dialog-backdrop" role="presentation" @keydown="onKeydown">
    <section ref="dialog" class="confirm-dialog" role="dialog" aria-modal="true" tabindex="-1" :aria-labelledby="`confirm-title-${title}`" @click.stop>
      <span class="section-kicker">需要确认</span>
      <h2 :id="`confirm-title-${title}`">{{ props.title }}</h2>
      <p>{{ props.message }}</p>
      <div class="button-row dialog-actions">
        <button ref="cancelButton" type="button" class="button-secondary" @click="emit('cancel')">{{ props.cancelLabel }}</button>
        <button type="button" :class="props.danger ? 'button-danger' : 'button-primary'" @click="emit('confirm')">{{ props.confirmLabel }}</button>
      </div>
    </section>
  </div>
</template>
