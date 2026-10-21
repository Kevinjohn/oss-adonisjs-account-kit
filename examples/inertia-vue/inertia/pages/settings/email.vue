<script setup lang="ts">
import { Form, Link } from '@adonisjs/inertia/vue'
import Section from '~/components/section.vue'
import ErrorSummary from '~/components/form_error_summary.vue'
import { focusFormErrorSummary } from '~/components/form_error_summary'
import AppLayout from '~/layouts/app.vue'
import SettingsLayout from '~/layouts/settings.vue'
defineOptions({ layout: [AppLayout, SettingsLayout] })
defineProps<{ email: string; pendingEmail: string | null; canRequestChange: boolean }>()
const requestFields = [
  { name: 'email', label: 'New email address' },
  { name: 'currentPassword', label: 'Current password' },
]
const cancelFields = [{ name: 'cancelCurrentPassword', label: 'Current password' }]
</script>
<template>
  <Section
    title="Email"
    description="Your current address remains active until you confirm a new one."
  >
    <p>
      Current address: <strong style="overflow-wrap: anywhere">{{ email }}</strong>
    </p>
    <p v-if="pendingEmail">
      Pending confirmation: <strong style="overflow-wrap: anywhere">{{ pendingEmail }}</strong>
    </p>
    <p v-if="!canRequestChange">
      Confirm your current address before requesting a new one. Visit the
      <Link href="/dashboard" class="il">dashboard</Link> to resend its verification link.
    </p>
    <Form
      v-if="canRequestChange"
      v-slot="{ errors, processing }"
      route="email_changes.store"
      @error="focusFormErrorSummary"
      ><div class="auth__form">
        <ErrorSummary :errors="errors" :fields="requestFields" />
        <div class="field">
          <label class="field__label" for="email">New email address</label
          ><input
            id="email"
            class="field__input"
            name="email"
            type="email"
            autocomplete="email"
            required
            :aria-invalid="errors.email ? 'true' : undefined"
            :aria-describedby="errors.email ? 'email-error' : undefined"
          /><span v-if="errors.email" id="email-error" class="field__error">{{
            errors.email
          }}</span>
        </div>
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
          {{ processing ? 'One moment…' : 'Request change' }}
        </button>
      </div></Form
    >
    <Form
      v-if="pendingEmail"
      v-slot="{ errors, processing }"
      route="email_changes.cancel"
      @error="focusFormErrorSummary"
      ><div class="auth__form">
        <p>Cancel the pending change with your current password.</p>
        <ErrorSummary :errors="errors" :fields="cancelFields" />
        <div class="field">
          <label class="field__label" for="cancelCurrentPassword">Current password</label
          ><input
            id="cancelCurrentPassword"
            class="field__input"
            name="cancelCurrentPassword"
            type="password"
            autocomplete="current-password"
            required
            :aria-invalid="errors.cancelCurrentPassword ? 'true' : undefined"
            :aria-describedby="errors.cancelCurrentPassword ? 'cancel-error' : undefined"
          /><span v-if="errors.cancelCurrentPassword" id="cancel-error" class="field__error">{{
            errors.cancelCurrentPassword
          }}</span>
        </div>
        <button class="btn" type="submit" :disabled="processing">
          {{ processing ? 'One moment…' : 'Cancel pending change' }}
        </button>
      </div></Form
    >
  </Section>
</template>
