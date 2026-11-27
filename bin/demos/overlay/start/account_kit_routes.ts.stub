import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'
import { AccountKit } from '@kevinjohn/adonisjs-account-kit'
import { createManagedGuard } from '@kevinjohn/adonisjs-account-kit/http'

const managedRoutes = await app.container.make('account_kit.managed_routes')

managedRoutes.register(router, {
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
