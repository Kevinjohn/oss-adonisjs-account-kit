<script setup lang="ts">
import { Form } from '@adonisjs/inertia/vue'
import Section from '~/components/section.vue'
import ErrorSummary from '~/components/form_error_summary.vue'
import { focusFormErrorSummary } from '~/components/form_error_summary'
import AppLayout from '~/layouts/app.vue'
import SettingsLayout from '~/layouts/settings.vue'
defineOptions({ layout: [AppLayout, SettingsLayout] })
const fields = [
  { name: 'currentPassword', label: 'Current password' },
  { name: 'password', label: 'New password' },
  { name: 'passwordConfirmation', label: 'Confirm new password' },
]
</script>
<template>
  <Section title="Password" description="Changing your password signs out other devices.">
    <Form
      v-slot="{ errors, processing }"
      route="passwords.update"
      v-bind="{ novalidate: true }"
      :reset-on-error="['currentPassword', 'password', 'passwordConfirmation']"
      :reset-on-success="['currentPassword', 'password', 'passwordConfirmation']"
      @error="focusFormErrorSummary"
      ><div class="auth__form">
        <ErrorSummary :errors="errors" :fields="fields" />
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
            :aria-describedby="errors.currentPassword ? 'current-error' : undefined"
          /><span v-if="errors.currentPassword" id="current-error" class="field__error">{{
            errors.currentPassword
          }}</span>
        </div>
        <div class="field">
          <label class="field__label" for="password">New password</label
          ><input
            id="password"
            class="field__input"
            name="password"
            type="password"
            autocomplete="new-password"
            required
            :aria-invalid="errors.password ? 'true' : undefined"
            :aria-describedby="errors.password ? 'password-error' : undefined"
          /><span v-if="errors.password" id="password-error" class="field__error">{{
            errors.password
          }}</span>
        </div>
        <div class="field">
          <label class="field__label" for="passwordConfirmation">Confirm new password</label
          ><input
            id="passwordConfirmation"
            class="field__input"
            name="passwordConfirmation"
            type="password"
            autocomplete="new-password"
            required
            :aria-invalid="errors.passwordConfirmation ? 'true' : undefined"
            :aria-describedby="errors.passwordConfirmation ? 'confirm-error' : undefined"
          /><span v-if="errors.passwordConfirmation" id="confirm-error" class="field__error">{{
            errors.passwordConfirmation
          }}</span>
        </div>
        <button class="btn btn--primary" type="submit" :disabled="processing">
          {{ processing ? 'One moment…' : 'Change password' }}
        </button>
      </div></Form
    >
  </Section>
</template>
