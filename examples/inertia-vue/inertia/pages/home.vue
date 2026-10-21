<script setup lang="ts">
import MarketingLayout from '~/layouts/marketing.vue'
defineOptions({ layout: MarketingLayout })
</script>
<template>
  <main class="home">
    <article class="prose-card">
      <div class="pc-top">
        <span class="pc-status mono tag" style="color: var(--ok)"
          ><span class="dot" /> Server ready</span
        >
      </div>
      <h1 class="pc-lead">Welcome to AdonisJS Account Kit.</h1>
      <p class="pc-para">
        This Vue and Inertia example shows how an application can compose signup, email proofs,
        sessions, and account settings.
      </p>
      <p class="pc-para">
        Create an account to follow the full journey, from verification through protected access.
      </p>
      <ul class="links">
        <li>
          <a class="lrow" href="https://docs.adonisjs.com" target="_blank" rel="noreferrer"
            ><span class="lrow__bullet" /><span class="lrow__title">AdonisJS documentation</span
            ><span class="lrow__desc">Guides and API reference</span></a
          >
        </li>
        <li>
          <a class="lrow" href="https://inertiajs.com" target="_blank" rel="noreferrer"
            ><span class="lrow__bullet" /><span class="lrow__title">Inertia documentation</span
            ><span class="lrow__desc">Server driven applications</span></a
          >
        </li>
      </ul>
      <div class="stack">
        <span class="tag">Built with</span>
        <div class="pile" role="list" aria-label="Tech stack">
          <span class="tile" role="listitem" title="AdonisJS">A</span
          ><span class="tile" role="listitem" title="Inertia">I</span
          ><span class="tile" role="listitem" title="Vue">V</span
          ><span class="tile" role="listitem" title="TypeScript">TS</span>
        </div>
      </div>
    </article>
  </main>
</template>
