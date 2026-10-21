<script setup lang="ts">
import { Link } from '@adonisjs/inertia/vue'
</script>
<template>
  <section class="page">
    <header class="page__header">
      <h1 class="page__title">Settings</h1>
      <p class="page__description">Manage your account settings.</p>
    </header>
    <div class="sidebar-layout">
      <nav class="sidebar-layout__nav" aria-label="Settings">
        <Link href="/settings/profile" class="sidebar-layout__item">Profile</Link>
        <Link href="/settings/email" class="sidebar-layout__item">Email</Link>
        <Link href="/settings/password" class="sidebar-layout__item">Password</Link>
      </nav>
      <div class="sidebar-layout__content panel"><slot /></div>
    </div>
  </section>
</template>
