import type { NotificationCallbacks } from '@kevinjohn/adonisjs-account-kit/types'
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import {
  createActionUrls,
  createLogNotifications,
  createLucidAdapter,
  defineConfig,
} from '@kevinjohn/adonisjs-account-kit'

const environment = app.inProduction ? 'production' : app.inTest ? 'test' : 'development'

const loadUser = async () => {
  const { default: User } = await import('#models/user')
  return User
}

/**
 * The optional starter full name is trimmed and stored on the new user when supplied.
 */
const fullNameFrom = (data: unknown) => {
  const fullName = (data as { fullName?: unknown } | null)?.fullName
  if (typeof fullName !== 'string' || fullName.trim() === '') return null
  return fullName.trim()
}

const users = createLucidAdapter(loadUser, {
  mapRegistrationData(data, user) {
    user.fullName = fullNameFrom(data)
  },
})

/**
 * Test seam: the kit freezes the notification callbacks it resolves from this file, so tests
 * replace entries in `notifyOverrides`. The kit calls through it at call time. When copying this
 * file, drop `notifyOverrides`, `lifecycleOverrides` and the wrappers built from them, and pass
 * the application's callbacks to `defineConfig` directly.
 */
export const notifyOverrides: NotificationCallbacks = createLogNotifications({
  brandName: 'My App',
  environment,
})

const overridable = notifyOverrides as unknown as Record<string, (...args: unknown[]) => unknown>
const notify = Object.fromEntries(
  Object.keys(notifyOverrides).map((name) => [
    name,
    (...args: unknown[]) => overridable[name](...args),
  ])
) as unknown as NotificationCallbacks

/** Test seam for the lifecycle observer; the kit freezes its configuration. */
export const lifecycleOverrides: { run?: (event: unknown) => Promise<void> } = {}

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
  limiterSecret: env.get('APP_KEY'),
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
  notify,
  /**
   * A no-op on purpose: session login checks the credential revision on every request, so older
   * sessions end on their own. Nothing else holds credentials in this app.
   */
  onCredentialsChangedTransaction: async () => {},
  onLifecycleEvent: async (event) => {
    await lifecycleOverrides.run?.(event)
  },
})
