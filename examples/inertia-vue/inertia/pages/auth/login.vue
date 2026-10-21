<script setup lang="ts">
import { Form, Link } from '@adonisjs/inertia/vue'
import ErrorSummary from '~/components/form_error_summary.vue'
import { focusFormErrorSummary } from '~/components/form_error_summary'
import AuthLayout from '~/layouts/auth.vue'
defineOptions({ layout: AuthLayout })
const fields = [
  { name: 'email', label: 'Email' },
  { name: 'password', label: 'Password' },
]
</script>
<template>
  <h1 class="auth__title">Welcome back</h1>
  <p class="auth__sub">Sign in to your account.</p>
  <Form
    v-slot="{ errors, processing }"
    route="session.store"
    v-bind="{ novalidate: true }"
    :reset-on-error="['password']"
    :reset-on-success="['password']"
    @error="focusFormErrorSummary"
  >
    <div class="auth__form">
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
      <div class="field">
        <label class="field__label" for="password">Password</label
        ><input
          id="password"
          class="field__input"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          :aria-invalid="errors.password ? 'true' : undefined"
          :aria-describedby="errors.password ? 'password-error' : undefined"
        /><span v-if="errors.password" id="password-error" class="field__error">{{
          errors.password
        }}</span>
      </div>
      <button class="btn btn--primary btn--block" type="submit" :disabled="processing">
        {{ processing ? 'One moment…' : 'Sign in' }}
      </button>
    </div>
  </Form>
  <p class="auth__foot"><Link href="/forgot-password" class="il">Forgot your password?</Link></p>
  <p class="auth__foot">New here? <Link href="/signup" class="il">Create an account</Link></p>
</template>
