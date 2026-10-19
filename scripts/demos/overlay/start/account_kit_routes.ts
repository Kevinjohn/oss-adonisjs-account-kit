import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'
import { createManagedGuard, registerManagedRoutes } from 'adonisjs-account-kit/http'

registerManagedRoutes(router, {
  prefix: '/api',
  enabled: [
    'authentication',
    'registration',
    'passwordReset',
    'emailVerification',
    'emailPasswordManagement',
    'invitations',
    'magicLinkLogin',
    'sessionManagement',
    'dataExport',
    'accountDeletion',
  ],
  verificationRequired: true,
  kit: () => app.container.make(AccountKit),
  guard: createManagedGuard({
    strategy: 'access_tokens',
    name: 'api',
    loadUser: async () => (await import('#models/user')).default,
  }),
})
