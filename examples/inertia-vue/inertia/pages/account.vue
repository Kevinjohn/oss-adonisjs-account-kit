<script setup lang="ts">
import AppLayout from '~/layouts/app.vue'
defineOptions({ layout: AppLayout })
</script>

<template>
  <section class="page">
    <header class="page__header">
      <h1 class="page__title">Your account is confirmed</h1>
      <p class="page__description">
        This page requires a signed-in account with a confirmed email address.
      </p>
    </header>
    <div class="panel"><p>You have access to this protected application page.</p></div>
  </section>
</template>
