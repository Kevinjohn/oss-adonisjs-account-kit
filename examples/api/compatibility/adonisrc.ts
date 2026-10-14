import { defineConfig } from '@adonisjs/core/app'

export default defineConfig({
  providers: [
    () => import('@adonisjs/lucid/database_provider'),
    () => import('@adonisjs/limiter/limiter_provider'),
  ],
  commands: [],
  preloads: [],
})
