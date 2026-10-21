<script setup lang="ts">
import { Form, Link } from '@adonisjs/inertia/vue'
import ErrorSummary from '~/components/form_error_summary.vue'
import { focusFormErrorSummary } from '~/components/form_error_summary'
import AuthLayout from '~/layouts/auth.vue'
defineOptions({ layout: AuthLayout })
const fields = [{ name: 'email', label: 'Email' }]
</script>
<template>
  <h1 class="auth__title">Forgot your password?</h1>
  <p class="auth__sub">Enter your email and we will send you a reset link.</p>
  <Form
    v-slot="{ errors, processing }"
    route="password_resets.store"
    reset-on-success
    @error="focusFormErrorSummary"
    ><div class="auth__form">
      <ErrorSummary :errors="errors" :fields="fields" />
      <div class="field">
        <label class="field__label" for="email">Email</label
        ><input
          id="email"
          class="field__input"
          name="email"
          type="email"
          autocomplete="username"
          required
          :aria-invalid="errors.email ? 'true' : undefined"
          :aria-describedby="errors.email ? 'email-error' : undefined"
        /><span v-if="errors.email" id="email-error" class="field__error">{{ errors.email }}</span>
      </div>
      <button class="btn btn--primary btn--block" type="submit" :disabled="processing">
        {{ processing ? 'One moment…' : 'Send reset link' }}
      </button>
    </div></Form
  >
  <p class="auth__foot">Remembered it? <Link href="/login" class="il">Sign in</Link></p>
</template>
