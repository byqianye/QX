<script setup lang="ts">
import { inject } from "vue";

import FavoritesView from "../FavoritesView.vue";
import { useCoreRouteContext } from "../core-route-context.js";

const context = useCoreRouteContext(inject);
</script>

<template>
  <FavoritesView
    :state="context.state.value.favorites"
    :pending="context.pending.value"
    @open="context.favoriteOpen"
    @delete="context.favoriteDelete"
    @move="context.favoriteMoveItem"
    @reorder="context.favoriteReorder"
    @create-group="context.favoriteCreateGroup"
    @rename-group="context.favoriteRenameGroup"
    @delete-group="context.favoriteDeleteGroup"
    @reorder-groups="context.favoriteReorderGroups"
  />
</template>
