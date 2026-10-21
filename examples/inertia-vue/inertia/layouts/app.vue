<script setup lang="ts">
import { Form, Link } from '@adonisjs/inertia/vue'
import FlashMessages from '~/components/flash_messages.vue'
</script>

<template>
  <header class="header header--bar">
    <div class="header__inner">
      <Link href="/" aria-label="AdonisJS" class="brand">◆ Account Kit</Link>
      <div class="header__right">
        <Form v-slot="{ processing }" route="session.destroy"
          ><button class="btn btn--secondary btn--sm" type="submit" :disabled="processing">
            {{ processing ? 'Logging out…' : 'Log out' }}
          </button></Form
        >
      </div>
    </div>
  </header>
  <nav class="subnav" aria-label="Primary">
    <div class="subnav__inner">
      <Link href="/dashboard" class="subnav__item">Dashboard</Link>
      <Link href="/settings/profile" class="subnav__item">Settings</Link>
    </div>
  </nav>
  <FlashMessages />
  <main class="app-main"><slot /></main>
</template>
