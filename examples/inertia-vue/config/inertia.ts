import { defineConfig } from '@adonisjs/inertia'

const inertiaConfig = defineConfig({
  /**
   * Encrypt page props kept in browser history; logout clears the key. Needs a secure context
   * (HTTPS, or localhost in development).
   */
  encryptHistory: true,

  /**
   * Server-side rendering options.
   */
  ssr: {
    /**
     * Toggle SSR mode for Inertia pages.
     */
    enabled: false,

    /**
     * Entry file used by the SSR server build.
     */
    entrypoint: 'inertia/ssr.ts',
  },
})

export default inertiaConfig
