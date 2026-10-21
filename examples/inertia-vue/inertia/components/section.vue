<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
</script>
<template>
  <section class="section">
    <header class="section__header">
      <h2 class="section__title">{{ title }}</h2>
      <p v-if="description" class="section__description">{{ description }}</p>
    </header>
    <div class="section__body"><slot /></div>
  </section>
</template>
