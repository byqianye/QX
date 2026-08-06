<script setup lang="ts">
import { ref, watch } from "vue";

import type { ImportState } from "./state.js";

const props = defineProps<{
  state: ImportState;
  pending: string | null;
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
    class="renderer-shell import-shell"
  >
    <header class="page-header">
      <p class="eyebrow">QX 影视</p>
      <h1>导入配置</h1>
      <p data-testid="import-status" :class="{ loading: props.state.loading }">
        {{ props.state.loading ? "正在读取配置" : props.state.status }}
      </p>
    </header>

    <form data-testid="config-import-form" @submit.prevent="submit">
      <label for="config-input">粘贴配置 URL、文件路径或原始 JSON</label>
      <textarea
        id="config-input"
        v-model="input"
        name="input"
        placeholder="https://... / C:\\config.json / {&quot;sites&quot;:[...]}"
        :disabled="props.pending !== null"
      />
      <button type="submit" :disabled="props.pending !== null">
        导入配置
      </button>
    </form>

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
          {{ site.name }} · {{ site.api }}
        </option>
      </select>
      <button type="submit" :disabled="props.pending !== null">选择站点</button>
    </form>

    <section
      v-if="props.state.status === 'confirmation_required' && props.state.warning"
      class="panel warning"
      data-testid="import-warning"
    >
      <strong>首次导入需要确认</strong>
      <p>{{ props.state.warning }}</p>
      <button type="button" data-action="confirm-import" :disabled="props.pending !== null" @click="emit('confirm')">
        确认并信任
      </button>
      <button type="button" data-action="cancel-import" :disabled="props.pending !== null" @click="emit('cancel')">
        取消
      </button>
    </section>

    <section v-if="props.state.error" class="panel error" data-testid="import-error">
      <strong>{{ props.state.error.code }}</strong>
      <p>{{ props.state.error.message }}</p>
    </section>
  </main>
</template>
