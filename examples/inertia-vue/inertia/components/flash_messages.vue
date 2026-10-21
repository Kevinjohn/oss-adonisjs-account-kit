<script setup lang="ts">
import { computed } from 'vue'
import { usePage } from '@inertiajs/vue3'
const page = usePage()
const messages = computed(() => {
  const flash = page.props.flash as { success?: string; error?: string } | undefined
  return [
    { kind: 'success', text: flash?.success },
    { kind: 'error', text: flash?.error },
  ].filter((item) => item.text)
})
</script>
<template>
  <div class="flash-messages" aria-live="polite" aria-atomic="true">
    <p
      v-for="message in messages"
      :key="message.kind"
      :role="message.kind === 'error' ? 'alert' : 'status'"
      class="panel"
    >
      {{ message.text }}
    </p>
  </div>
</template>
