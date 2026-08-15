<script setup lang="ts">
import { computed, ref, watch } from "vue";

import AppErrorDetails from "./AppErrorDetails.vue";
import { toAppError } from "./error.js";
import ErrorState from "./ErrorState.vue";
import TrustConfirmationDialog from "./TrustConfirmationDialog.vue";
import { displaySource } from "./safe-display.js";
import type { ImportState } from "./state.js";

const props = defineProps<{
  state: ImportState;
  pending: string | null;
  persistenceDiagnostic?: { code: string; message: string } | null;
}>();

const emit = defineEmits<{
  load: [input: string];
  loadFile: [file: { name: string; text: string }];
  select: [siteKey: string];
  confirm: [];
  cancel: [];
}>();

const input = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const selectedSiteKey = ref(props.state.selectedSiteKey ?? "");
const appError = computed(() => toAppError(props.state.error, "config"));
const persistenceError = computed(() => props.persistenceDiagnostic
  ? toAppError(props.persistenceDiagnostic, "persistence")
  : null);

watch(() => props.state.selectedSiteKey, (value) => {
  selectedSiteKey.value = value ?? "";
});

function submit(): void {
  emit("load", input.value.trim());
}

async function selectFile(event: Event): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.files?.[0]) return;
  const file = target.files[0];
  emit("loadFile", { name: file.name, text: await file.text() });
  if (fileInput.value) fileInput.value.value = "";
}

function selectSite(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLSelectElement) {
    selectedSiteKey.value = target.value;
    emit("select", target.value);
  }
}

function submitSite(): void {
  if (selectedSiteKey.value) emit("select", selectedSiteKey.value);
}
</script>

<template>
  <main
    data-testid="config-import-ui"
    :data-status="props.state.status"
    class="import-shell"
  >
    <div class="import-brand" aria-label="QX 影视">
      <span class="brand-mark" aria-hidden="true">Q</span>
      <div><strong>QX 影视</strong><span>媒体工作台</span></div>
    </div>
    <header class="import-header">
      <span class="section-kicker">开始使用</span>
      <h1>导入你的媒体配置</h1>
      <p data-testid="import-status" :class="{ loading: props.state.loading }">{{ props.state.loading ? "正在读取配置" : "连接一个已授权来源" }}</p>
    </header>

    <section class="first-launch-guide" data-testid="first-launch-guide">
      <div><strong>第一次使用</strong><span>先导入已授权的来源，再开始观看流程</span></div>
      <ul>
        <li><b>添加配置</b><span>导入你有权访问的媒体配置，先看来源摘要再确认。</span></li>
      </ul>
    </section>

    <section class="import-card">
      <form data-testid="config-import-form" @submit.prevent="submit">
        <label for="config-input">配置地址或原始 JSON</label>
        <textarea id="config-input" v-model="input" name="input" placeholder="https://... / {&quot;sites&quot;:[...]}" :disabled="props.pending !== null" />
        <div class="form-footer">
          <span class="meta">配置只在本机解析；导入前会显示来源摘要。</span>
          <button type="submit" class="button-primary" :disabled="props.pending !== null">导入配置</button>
        </div>
      </form>
      <div class="file-import-row">
        <label for="config-file">或选择本地配置文件</label>
        <input id="config-file" ref="fileInput" type="file" accept=".json,.txt,application/json,text/plain" :disabled="props.pending !== null" @change="selectFile" />
      </div>
    </section>

    <section v-if="props.state.summary" data-testid="config-summary" class="panel">
      <strong>配置摘要</strong>
      <p>
        已发现站点 {{ props.state.summary.siteCount }} 个
      </p>
    </section>

    <form
      v-if="props.state.sites.length > 0"
      data-testid="site-selector"
      @submit.prevent="submitSite"
    >
      <label for="site-key">选择来源站点</label>
      <select id="site-key" v-model="selectedSiteKey" name="siteKey" @change="selectSite">
        <option v-for="site in props.state.sites" :key="site.key" :value="site.key">
          {{ site.name }} · {{ displaySource(site.api) }}
        </option>
      </select>
      <button type="submit" :disabled="props.pending !== null">选择站点</button>
    </form>

    <TrustConfirmationDialog
      :open="props.state.status === 'confirmation_required'"
      :warning="props.state.warning"
      :pending="props.pending !== null"
      :target="props.state.source ?? undefined"
      @confirm="emit('confirm')"
      @cancel="emit('cancel')"
    />

    <ErrorState
      v-if="appError"
      :error="appError"
      :pending="props.pending !== null"
      :show-switch-line="false"
      :show-back="false"
      :show-settings="false"
      @retry="submit"
    />

    <section v-if="props.persistenceDiagnostic" class="panel warning" data-testid="persistence-diagnostic">
      <strong>{{ props.persistenceDiagnostic.code }}</strong>
      <p>{{ props.persistenceDiagnostic.message }}</p>
      <p class="meta">已使用安全默认值；不会显示原始路径或敏感内容。</p>
      <AppErrorDetails v-if="persistenceError" :error="persistenceError" />
    </section>
  </main>
</template>
