/* eslint-disable @unicorn/no-await-expression-member -- Keep the transaction-aware Lucid query and result together in the adapter callbacks. */

import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { createLucidAdapter, defineConfig } from 'adonisjs-account-kit'
import { withAdmissionCleanup, withInvitationEvidence } from 'adonisjs-account-kit/admission'
import { notifications } from '#services/account_kit_notifications'
import { createNotify } from './account_kit_notifications.js'
import { onCredentialsChangedTransaction } from './account_kit_credential_notice.js'
import {
  authorize,
  canAccess,
  exportAccountData,
  onInvitationAccepted,
} from '#services/account_kit_authorization'
import { registrationFullName } from '#services/registration_fields'
import { referencePasswordLimits } from '#validators/password'
import { allySocialProvider } from '#services/social_provider'

// Tests swap Ally for a deterministic fixture; production never loads test code.
const socialProvider = app.inTest
  ? (await import('#tests/helpers/social_provider_fixture')).fixtureProvider
  : allySocialProvider

const normalizeBaseUrl = (value: string) => (value.endsWith('/') ? value : `${value}/`)
const appUrl = normalizeBaseUrl(env.get('APP_URL'))
const authStrategy = env.get('ACCOUNT_KIT_AUTH_STRATEGY') ?? 'access_tokens'
const accountUrl = (path: string, token: string) =>
  new URL(`api/v1/auth/${path}/${encodeURIComponent(token)}`, appUrl).toString()

if (env.get('ACCOUNT_KIT_AUTH_STRATEGY') === 'session' && env.get('SESSION_DRIVER') === 'cookie') {
  throw new Error('account_kit: session authentication requires a server-side session store')
}

const notify = createNotify(accountUrl)

const loadUser = async () => (await import('#models/user')).default
const users = createLucidAdapter(loadUser, {
  mapRegistrationData(data, user) {
    const fullName = registrationFullName(data)
    if (!fullName) throw new Error('A full name is required to create an account')
    user.fullName = fullName
  },
})

export default defineConfig({
  passwordPolicy: referencePasswordLimits,
  enabled: [
    'passwordReset',
    'emailVerification',
    'invitations',
    'emailPasswordManagement',
    'registration',
    'socialAuthentication',
  ],
  users,
  registration: {
    availability: 'open',
    mapFields(data) {
      const fullName = registrationFullName(data)
      if (!fullName || fullName.length > 100)
        throw new Error('A full name of at most 100 characters is required')
      return { fullName }
    },
  },
  socialAuthentication: {
    providers: { google: socialProvider('google'), github: socialProvider('github') },
  },
  authentication: {
    strategy: authStrategy,
    guard: authStrategy === 'session' ? 'web' : 'api',
    ...(authStrategy === 'access_tokens' ? { tokenExpiresIn: '1d', tokenAbilities: ['*'] } : {}),
    canAccess,
  },
  limiterSecret: env.get('APP_KEY'),
  // The functional suite sends many requests from one client; production keeps the package
  // default of five requests per 15 minutes.
  ...(app.inTest ? { throttle: { requests: 100, duration: '15m' } } : {}),
  authorize,
  urls: {
    passwordReset: (token) => accountUrl('password-reset', token),
    emailVerification: (token) => accountUrl('email-verification', token),
    invitation: (token) => accountUrl('invitations', token),
    emailChange: (token) => accountUrl('email-change', token),
  },
  notify,
  // Records invitation evidence for admission, then grants the role, in the acceptance transaction.
  onInvitationAccepted: withInvitationEvidence(onInvitationAccepted),
  onAccountDeletingTransaction: withAdmissionCleanup(),
  exportAccountData,
  onCredentialsChangedTransaction,
  onLifecycleEvent: async (event) => notifications.recordLifecycle(event),
})
