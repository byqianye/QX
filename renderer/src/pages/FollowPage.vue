<script setup lang="ts">
import { inject } from "vue";

import FollowView from "../FollowView.vue";
import { useCoreRouteContext } from "../core-route-context.js";

const context = useCoreRouteContext(inject);
</script>

<template>
  <section class="core-page follow-page-route" data-testid="core-follow-page">
    <FollowView
      :state="context.state.value.follow"
      :pending="context.pending.value"
      @refresh="context.followRefresh"
      @open="context.followOpen"
      @delete="context.followDelete"
      @mark-watched="context.followMarkWatched"
      @mark-unwatched="context.followMarkUnwatched"
    />
  </section>
</template>
