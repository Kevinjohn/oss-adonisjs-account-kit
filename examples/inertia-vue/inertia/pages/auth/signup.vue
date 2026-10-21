<script setup lang="ts">
import { Form, Link } from '@adonisjs/inertia/vue'
import ErrorSummary from '~/components/form_error_summary.vue'
import { focusFormErrorSummary } from '~/components/form_error_summary'
import AuthLayout from '~/layouts/auth.vue'
defineOptions({ layout: AuthLayout })
const fields = [
  { name: 'fullName', label: 'Full name' },
  { name: 'email', label: 'Email' },
  { name: 'password', label: 'Password' },
  { name: 'passwordConfirmation', label: 'Confirm password' },
]
</script>
<template>
  <h1 class="auth__title">Create your account</h1>
  <p class="auth__sub">Start building with the starter kit.</p>
  <Form v-slot="{ errors, processing }" route="new_account.store" @error="focusFormErrorSummary"
    ><div class="auth__form">
      <ErrorSummary :errors="errors" :fields="fields" />
      <div class="field">
        <label class="field__label" for="fullName">Full name</label
        ><input
          id="fullName"
          class="field__input"
          name="fullName"
          autocomplete="name"
          required
          :aria-invalid="!!errors.fullName"
          :aria-describedby="errors.fullName ? 'name-error' : undefined"
        /><span v-if="errors.fullName" id="name-error" class="field__error">{{
          errors.fullName
        }}</span>
      </div>
      <div class="field">
        <label class="field__label" for="email">Email</label
        ><input
          id="email"
          class="field__input"
          name="email"
          type="email"
          autocomplete="email"
          required
          :aria-invalid="!!errors.email"
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
          autocomplete="new-password"
          required
          :aria-invalid="!!errors.password"
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
          :aria-invalid="!!errors.passwordConfirmation"
          :aria-describedby="errors.passwordConfirmation ? 'confirm-error' : undefined"
        /><span v-if="errors.passwordConfirmation" id="confirm-error" class="field__error">{{
          errors.passwordConfirmation
        }}</span>
      </div>
      <button class="btn btn--primary btn--block" type="submit" :disabled="processing">
        {{ processing ? 'One moment…' : 'Create account' }}
      </button>
    </div></Form
  >
  <p class="auth__foot">Already have an account? <Link href="/login" class="il">Sign in</Link></p>
</template>
