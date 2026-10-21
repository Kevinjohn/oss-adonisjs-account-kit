<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

type Field = { name: string; label: string }
const props = defineProps<{ errors: Record<string, string>; fields: readonly Field[] }>()
const summary = ref<HTMLElement>()
const invalidFields = computed(() => props.fields.filter(({ name }) => props.errors[name]))

watch(
  invalidFields,
  async (fields) => {
    if (fields.length) {
      await nextTick()
      summary.value?.focus()
    }
  },
  { flush: 'post' }
)
</script>

<template>
  <div
    v-if="invalidFields.length"
    ref="summary"
    role="alert"
    tabindex="-1"
    class="field__error"
    data-form-error-summary
  >
    <p>Check these fields:</p>
    <ul>
      <li v-for="field in invalidFields" :key="field.name">
        <a class="il" :href="`#${field.name}`">{{ field.label }}</a>
      </li>
    </ul>
  </div>
</template>
