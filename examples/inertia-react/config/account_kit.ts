import app from '@adonisjs/core/services/app'
import env from '#start/env'
import {
  createActionUrls,
  createLogNotifications,
  createLucidAdapter,
  defineConfig,
} from 'adonisjs-account-kit'

if (env.get('SESSION_DRIVER') === 'cookie') {
  throw new Error('account_kit: session login needs a server-side session store')
}

const environment = app.inProduction ? 'production' : app.inTest ? 'test' : 'development'

const loadUser = async () => {
  const { default: User } = await import('#models/user')
  return User
}

const users = createLucidAdapter(loadUser, {
  mapRegistrationData(data, user) {
    user.fullName = (data as { fullName?: string | null }).fullName ?? null
  },
})

export default defineConfig({
  users,
  enabled: ['passwordReset', 'emailVerification', 'emailPasswordManagement', 'registration'],
  registration: {
    availability: 'open',
    mapFields: (data) => ({ fullName: (data as { fullName?: string | null }).fullName ?? null }),
  },
  authentication: {
    strategy: 'session',
    guard: 'web',
    canAccess: async () => true,
  },
  limiterSecret: env.get('APP_KEY').release(),
  authorize: {
    invite: async () => false,
    manageInvitation: async () => false,
    listInvitations: async () => false,
  },
  // Links are built from APP_URL only, and must use HTTPS outside localhost.
  urls: createActionUrls({
    backendOrigin: env.get('APP_URL'),
    appFrontendUrl: env.get('APP_URL'),
    environment,
    destinations: {
      passwordReset: 'reset-password',
      emailVerification: 'verify-email',
      invitation: 'invitation',
      emailChange: 'confirm-email',
    },
  }),
  // Prints each email, link included, to the server log, and refuses to boot in production.
  // Before deploying, add @adonisjs/mail and switch to createMailNotifications.
  notify: createLogNotifications({ brandName: 'My App', environment }),
  // Session login checks the credential revision on every request, so older sessions end on
  // their own. Nothing else holds credentials in this app.
  onCredentialsChangedTransaction: async () => {},
})
