<script setup lang="ts">
import { Form } from '@adonisjs/inertia/vue'
import AppLayout from '~/layouts/app.vue'
defineOptions({ layout: AppLayout })
defineProps<{ emailVerified: boolean }>()
</script>
<template>
  <section class="page">
    <div v-if="!emailVerified" class="panel" style="padding: 16px; margin-bottom: 16px">
      <Form v-slot="{ processing }" route="email_verifications.store"
        ><p style="display: flex; gap: 12px; align-items: center; margin: 0">
          Confirm your email address with the link we sent you.<button
            class="btn btn--secondary btn--sm"
            type="submit"
            :disabled="processing"
          >
            {{ processing ? 'Sending…' : 'Resend link' }}
          </button>
        </p></Form
      >
    </div>
    <div class="empty">
      <div class="empty__mark" aria-hidden="true">◆</div>
      <h1>Your dashboard is ready</h1>
      <p>It’s empty on purpose. Add your first route and component to begin.</p>
      <p class="mono" style="font-size: 12.5px; color: var(--subtle); margin-top: 4px">
        Start in <span class="kbd">inertia/pages/dashboard.vue</span>
      </p>
    </div>
  </section>
</template>
