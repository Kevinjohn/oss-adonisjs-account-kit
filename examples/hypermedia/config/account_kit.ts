import app from '@adonisjs/core/services/app'
import env from '#start/env'
import {
  createActionUrls,
  createLogNotifications,
  createLucidAdapter,
  defineConfig,
} from 'adonisjs-account-kit'
import { accountKitNotify } from '#services/account_kit_notifications'

const environment = app.inProduction ? 'production' : app.inTest ? 'test' : 'development'

const loadUser = async () => {
  const { default: User } = await import('#models/user')
  return User
}

/**
 * The starter signup form sends a full name; Account Kit stores it on the new user.
 */
const fullNameFrom = (data: unknown) => (data as { fullName?: string | null }).fullName ?? null

const users = createLucidAdapter(loadUser, {
  mapRegistrationData(data, user) {
    user.fullName = fullNameFrom(data)
  },
})

export default defineConfig({
  users,
  enabled: ['passwordReset', 'emailVerification', 'emailPasswordManagement', 'registration'],
  registration: {
    availability: 'open',
    mapFields: (data) => ({ fullName: fullNameFrom(data) }),
  },
  authentication: {
    strategy: 'session',
    guard: 'web',
    /**
     * Every account may sign in. Return false here to block an account.
     */
    canAccess: async () => true,
  },
  limiterSecret: env.get('APP_KEY').release(),
  /**
   * This app sends no invitations, so every invitation action is refused.
   */
  authorize: {
    invite: async () => false,
    manageInvitation: async () => false,
    listInvitations: async () => false,
  },
  /**
   * Links are built from APP_URL only, and must use HTTPS outside localhost.
   */
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
  /**
   * Prints each email, link included, to the server log, and refuses to boot in production.
   * Before deploying, add @adonisjs/mail and switch to createMailNotifications.
   */
  notify: app.inTest
    ? accountKitNotify
    : createLogNotifications({ brandName: 'Account Kit Example', environment }),
  /**
   * A no-op on purpose: session login checks the credential revision on every request, so older
   * sessions end on their own. Nothing else holds credentials in this app.
   */
  onCredentialsChangedTransaction: async () => {},
})
