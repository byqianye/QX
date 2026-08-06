<script setup lang="ts">
import { ref, watch } from "vue";

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
  select: [siteKey: string];
  confirm: [];
  cancel: [];
}>();

const input = ref("");
const selectedSiteKey = ref(props.state.selectedSiteKey ?? "");

watch(() => props.state.selectedSiteKey, (value) => {
  selectedSiteKey.value = value ?? "";
});

function submit(): void {
  emit("load", input.value.trim());
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

    <section class="import-card">
      <form data-testid="config-import-form" @submit.prevent="submit">
        <label for="config-input">配置 URL、文件路径或原始 JSON</label>
        <textarea id="config-input" v-model="input" name="input" placeholder="https://... / C:\\config.json / {&quot;sites&quot;:[...]}" :disabled="props.pending !== null" />
        <div class="form-footer">
          <span class="meta">配置只在本机解析；导入前会显示来源摘要。</span>
          <button type="submit" class="button-primary" :disabled="props.pending !== null">导入配置</button>
        </div>
      </form>
    </section>

    <section v-if="props.state.summary" data-testid="config-summary" class="panel">
      <strong>配置摘要</strong>
      <p>
        站点 {{ props.state.summary.siteCount }} 个，Spider：{{ props.state.summary.hasSpider ? "有" : "无" }}
      </p>
    </section>

    <form
      v-if="props.state.sites.length > 0"
      data-testid="site-selector"
      @submit.prevent="submitSite"
    >
      <label for="site-key">Spider 站点</label>
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

    <section v-if="props.state.error" class="panel error" data-testid="import-error">
      <strong>{{ props.state.error.code }}</strong>
      <p>{{ props.state.error.message }}</p>
    </section>

    <section v-if="props.persistenceDiagnostic" class="panel warning" data-testid="persistence-diagnostic">
      <strong>{{ props.persistenceDiagnostic.code }}</strong>
      <p>{{ props.persistenceDiagnostic.message }}</p>
      <p class="meta">已使用安全默认值；不会显示原始路径或敏感内容。</p>
    </section>
  </main>
</template>
