// Demo configuration: every capability except social sign-in, with emails printed to the log.
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { createLogNotifications, createLucidAdapter, defineConfig } from 'adonisjs-account-kit'

const appUrl = env.get('APP_URL').endsWith('/') ? env.get('APP_URL') : env.get('APP_URL') + '/'
const link = (path: string) => (token: string) =>
  new URL(`api/auth/${path}/${encodeURIComponent(token)}`, appUrl).toString()

export default defineConfig({
  users: createLucidAdapter(async () => (await import('#models/user')).default),
  enabled: [
    'passwordReset',
    'emailVerification',
    'emailPasswordManagement',
    'registration',
    'invitations',
    'magicLinkLogin',
    'sessionManagement',
    'dataExport',
    'accountDeletion',
  ],
  registration: { availability: 'open' },
  authentication: { strategy: 'access_tokens', guard: 'api' },
  limiterSecret: env.get('APP_KEY').release(),
  authorize: {
    invite: async () => true,
    manageInvitation: async () => true,
    listInvitations: async () => true,
  },
  urls: {
    passwordReset: link('password-reset'),
    emailVerification: link('email-verification'),
    invitation: link('invitations'),
    emailChange: link('email-change'),
    magicLink: link('magic-link'),
  },
  notify: createLogNotifications({
    brandName: 'Demo',
    environment: app.inProduction ? 'production' : 'development',
  }),
  // The access-token guard deletes a user's tokens on every credential change.
  onCredentialsChangedTransaction: async () => {},
  onInvitationAccepted: async () => {},
})
