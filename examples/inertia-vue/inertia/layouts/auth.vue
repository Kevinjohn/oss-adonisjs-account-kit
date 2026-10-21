<script setup lang="ts">
import FlashMessages from '~/components/flash_messages.vue'
</script>
<template>
  <main class="auth">
    <section class="auth__form-col">
      <a href="/" class="brand">◆ Account Kit</a>
      <FlashMessages />
      <div class="auth__form-wrap"><slot /></div>
    </section>
    <aside class="auth__aside">
      <p class="auth__quote">Account security that fits your application.</p>
      <p>Built with AdonisJS, Inertia and Vue.</p>
    </aside>
  </main>
</template>
