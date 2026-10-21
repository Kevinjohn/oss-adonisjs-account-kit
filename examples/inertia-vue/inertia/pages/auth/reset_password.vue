<script setup lang="ts">
import { Form, Link } from '@adonisjs/inertia/vue'
import ErrorSummary from '~/components/form_error_summary.vue'
import { focusFormErrorSummary } from '~/components/form_error_summary'
import AuthLayout from '~/layouts/auth.vue'
defineOptions({ layout: AuthLayout })
defineProps<{ token: string; valid: boolean }>()
const fields = [
  { name: 'password', label: 'New password' },
  { name: 'passwordConfirmation', label: 'Confirm new password' },
]
</script>
<template>
  <template v-if="!valid"
    ><h1 class="auth__title">This link can’t be used</h1>
    <p class="auth__sub">It may be invalid, already used, or expired.</p>
    <p class="auth__foot">Sign in to your account, then request another reset link.</p>
    <Link href="/forgot-password" class="btn btn--primary btn--block">Request a new link</Link>
    <p class="auth__foot"><Link href="/login" class="il">Sign in</Link></p></template
  ><template v-else>
    <h1 class="auth__title">Choose a new password</h1>
    <p class="auth__sub">Resetting ends existing sessions. Sign in with the new password.</p>
    <Form
      v-slot="{ errors, processing }"
      route="password_resets.update"
      :params="{ token }"
      :reset-on-error="['password', 'passwordConfirmation']"
      :reset-on-success="['password', 'passwordConfirmation']"
      @error="focusFormErrorSummary"
      ><div class="auth__form">
        <ErrorSummary :errors="errors" :fields="fields" />
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
            :aria-describedby="errors.password ? 'reset-password-error' : undefined"
          /><span v-if="errors.password" id="reset-password-error" class="field__error">{{
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
            :aria-describedby="
              errors.passwordConfirmation ? 'reset-passwordConfirmation-error' : undefined
            "
          /><span
            v-if="errors.passwordConfirmation"
            id="reset-passwordConfirmation-error"
            class="field__error"
            >{{ errors.passwordConfirmation }}</span
          >
        </div>
        <button class="btn btn--primary btn--block" type="submit" :disabled="processing">
          {{ processing ? 'One moment…' : 'Reset password' }}
        </button>
      </div></Form
    ></template
  >
</template>
