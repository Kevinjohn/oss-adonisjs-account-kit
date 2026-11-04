<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

const props = defineProps<{ recording: string; description: string }>()
const files = import.meta.glob<string>('../../../assets/demos/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
})
const sources = computed(() => {
  const still = files[`../../../assets/demos/${props.recording}_still.svg`]
  const animation = files[`../../../assets/demos/${props.recording}.svg`]
  if (!still || !animation) throw new Error(`Missing recording pair: ${props.recording}`)
  return { still, animation }
})
const hydrated = ref(false)
const showAnimation = ref(false)

onMounted(() => {
  hydrated.value = true
})
</script>

<template>
  <figure class="recording">
    <img v-if="showAnimation" :src="sources.animation" :alt="description" />
    <img v-else :src="sources.still" :alt="description" />
    <figcaption>
      <p>{{ description }}</p>
      <button
        v-if="hydrated"
        type="button"
        :aria-pressed="showAnimation"
        @click="showAnimation = !showAnimation"
      >
        {{ showAnimation ? 'Hide animation' : 'Show animation' }}
      </button>
    </figcaption>
  </figure>
</template>

<style scoped>
.recording {
  margin: 24px 0;
}

.recording img {
  display: block;
  width: 100%;
}

.recording figcaption p {
  color: var(--vp-c-text-2);
  font-size: 14px;
}

.recording button {
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 6px 12px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font: inherit;
  cursor: pointer;
}

.recording button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}
</style>
