<script setup lang="ts">
import { Form, Link } from '@adonisjs/inertia/vue'
import ErrorSummary from '~/components/form_error_summary.vue'
import { focusFormErrorSummary } from '~/components/form_error_summary'
import AuthLayout from '~/layouts/auth.vue'
defineOptions({ layout: AuthLayout })
defineProps<{ token: string; valid: boolean }>()
const fields = [
  { name: 'password', label: 'Password' },
  { name: 'passwordConfirmation', label: 'Confirm password' },
]
</script>
<template>
  <template v-if="!valid"
    ><h1 class="auth__title">This link can’t be used</h1>
    <p class="auth__sub">It may be invalid, already used, or expired.</p>
    <p class="auth__foot">Sign in and request a fresh verification link.</p>
    <Link href="/login" class="btn btn--primary btn--block">Sign in</Link></template
  ><template v-else>
    <h1 class="auth__title">Confirm your email</h1>
    <p class="auth__sub">
      Choose a password to confirm the address. Any current session will end; sign in again after
      confirmation.
    </p>
    <Form
      v-slot="{ errors, processing }"
      route="email_verifications.update"
      :params="{ token }"
      v-bind="{ novalidate: true }"
      :reset-on-error="['password', 'passwordConfirmation']"
      :reset-on-success="['password', 'passwordConfirmation']"
      @error="focusFormErrorSummary"
      ><div class="auth__form">
        <ErrorSummary :errors="errors" :fields="fields" />
        <div class="field">
          <label class="field__label" for="password">Password</label
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
          <label class="field__label" for="passwordConfirmation">Confirm password</label
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
        <button class="btn btn--primary btn--block" type="submit" :disabled="processing">
          {{ processing ? 'One moment…' : 'Confirm email' }}
        </button>
      </div></Form
    ></template
  >
</template>
