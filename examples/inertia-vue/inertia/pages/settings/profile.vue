<script setup lang="ts">
import { Form } from '@adonisjs/inertia/vue'
import Section from '~/components/section.vue'
import ErrorSummary from '~/components/form_error_summary.vue'
import { focusFormErrorSummary } from '~/components/form_error_summary'
import AppLayout from '~/layouts/app.vue'
import SettingsLayout from '~/layouts/settings.vue'
defineOptions({ layout: [AppLayout, SettingsLayout] })
defineProps<{ profile: { fullName: string | null; email: string } }>()
const fields = [
  { name: 'fullName', label: 'Full name' },
  { name: 'currentPassword', label: 'Current password' },
]
</script>
<template>
  <Section
    title="Profile"
    description="Your name saves immediately. Confirm with your current password."
  >
    <Form
      v-slot="{ errors, processing }"
      route="profile.update"
      :reset-on-error="['currentPassword']"
      :reset-on-success="['currentPassword']"
      @error="focusFormErrorSummary"
      ><div class="auth__form">
        <ErrorSummary :errors="errors" :fields="fields" />
        <div class="field">
          <label class="field__label" for="fullName">Full name</label
          ><input
            id="fullName"
            class="field__input"
            name="fullName"
            autocomplete="name"
            :value="profile.fullName ?? ''"
            required
            :aria-invalid="errors.fullName ? 'true' : undefined"
            :aria-describedby="errors.fullName ? 'name-error' : undefined"
          /><span v-if="errors.fullName" id="name-error" class="field__error">{{
            errors.fullName
          }}</span>
        </div>
        <p>
          Signed in as <span style="overflow-wrap: anywhere">{{ profile.email }}</span>
        </p>
        <div class="field">
          <label class="field__label" for="currentPassword">Current password</label
          ><input
            id="currentPassword"
            class="field__input"
            name="currentPassword"
            type="password"
            autocomplete="current-password"
            required
            :aria-invalid="errors.currentPassword ? 'true' : undefined"
            :aria-describedby="errors.currentPassword ? 'proof-error' : undefined"
          /><span v-if="errors.currentPassword" id="proof-error" class="field__error">{{
            errors.currentPassword
          }}</span>
        </div>
        <button class="btn btn--primary" type="submit" :disabled="processing">
          {{ processing ? 'One moment…' : 'Save profile' }}
        </button>
      </div></Form
    >
  </Section>
</template>
