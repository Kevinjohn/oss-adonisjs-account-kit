<script setup lang="ts">
import { Link } from '@adonisjs/inertia/vue'
import { usePage } from '@inertiajs/vue3'
const page = usePage()
</script>
<template>
  <header class="header header--floating">
    <div class="header__inner">
      <Link href="/" class="brand">◆ Account Kit</Link>
      <div class="header__right">
        <Link v-if="page.props.user" href="/dashboard" class="btn btn--primary btn--sm"
          >Dashboard</Link
        >
        <template v-else
          ><Link href="/login" class="btn btn--ghost btn--sm">Sign in</Link
          ><Link href="/signup" class="btn btn--primary btn--sm">Get started</Link></template
        >
      </div>
    </div>
  </header>
  <slot />
</template>
