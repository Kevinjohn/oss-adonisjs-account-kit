<script setup lang="ts">
import { Form, Link } from '@adonisjs/inertia/vue'
import AuthLayout from '~/layouts/auth.vue'
defineOptions({ layout: AuthLayout })
defineProps<{ token: string; valid: boolean }>()
</script>
<template>
  <template v-if="!valid"
    ><h1 class="auth__title">This link can’t be used</h1>
    <p class="auth__sub">It may be invalid, already used, or expired.</p>
    <Link href="/settings/email" class="btn btn--primary btn--block">Email settings</Link>
    <p class="auth__foot"><Link href="/login" class="il">Sign in</Link></p></template
  ><template v-else>
    <h1 class="auth__title">Confirm your new email</h1>
    <p class="auth__sub">
      Confirming changes your sign-in address and ends current sessions. Sign in again with the new
      address.
    </p>
    <Form v-slot="{ processing }" route="email_changes.complete" :params="{ token }"
      ><button class="btn btn--primary btn--block" type="submit" :disabled="processing">
        {{ processing ? 'One moment…' : 'Confirm email change' }}
      </button></Form
    >
  </template>
</template>
