<script setup lang="ts">
import { inject } from "vue";

import HistoryView from "../HistoryView.vue";
import { useCoreRouteContext } from "../core-route-context.js";

const context = useCoreRouteContext(inject);
</script>

<template>
  <HistoryView
    :state="context.state.value.history"
    :pending="context.pending.value"
    @open="context.historyOpen"
    @delete="context.historyDelete"
    @delete-progress="context.historyDeleteProgress"
    @clear="context.historyClear"
    @pause="context.historyPause"
  />
</template>
