/* eslint-disable @unicorn/no-await-expression-member -- Keep the transaction-aware Lucid query and result together in the adapter callbacks. */

import app from '@adonisjs/core/services/app'
import env from '#start/env'
import {
  createLucidAdapter,
  defineConfig,
  type AccountUser,
  type Invitation,
  type Trx,
} from 'adonisjs-account-kit'
import db from '@adonisjs/lucid/services/db'
import { notifications } from '#services/account_kit_notifications'
import { referencePasswordLimits } from '#validators/password'

const normalizeBaseUrl = (value: string) => (value.endsWith('/') ? value : `${value}/`)
const appUrl = normalizeBaseUrl(env.get('APP_URL'))
const authStrategy = env.get('ACCOUNT_KIT_AUTH_STRATEGY') ?? 'access_tokens'
const accountUrl = (path: string, token: string) =>
  new URL(`api/v1/auth/${path}/${encodeURIComponent(token)}`, appUrl).toString()

if (env.get('ACCOUNT_KIT_AUTH_STRATEGY') === 'session' && env.get('SESSION_DRIVER') === 'cookie') {
  throw new Error('account_kit: session authentication requires a server-side session store')
}

const loadUser = async () => (await import('#models/user')).default
const users = createLucidAdapter(loadUser, {
  mapRegistrationData(data, user) {
    const fullName = (data as { fullName?: unknown } | null)?.fullName
    if (typeof fullName !== 'string' || fullName.trim() === '') {
      throw new Error('A full name is required to create an account')
    }
    user.fullName = fullName.trim()
  },
})

async function isOwner(userId: number | string, trx?: Trx): Promise<boolean> {
  const query = trx ? trx.from('role_assignments') : db.from('role_assignments')
  return Boolean(await query.where('user_id', userId).where('role', 'owner').first())
}

export default defineConfig({
  users,
  passwordPolicy: referencePasswordLimits,
  enabled: [
    'passwordReset',
    'emailVerification',
    'invitations',
    'emailPasswordManagement',
    'registration',
  ],
  registration: {
    availability: 'open',
    mapFields(data) {
      const fullName = (data as { fullName?: unknown } | null)?.fullName
      if (
        typeof fullName !== 'string' ||
        fullName.trim().length === 0 ||
        fullName.trim().length > 100
      )
        throw new Error('A full name of at most 100 characters is required')
      return { fullName: fullName.trim() }
    },
  },
  authentication: {
    strategy: authStrategy,
    guard: authStrategy === 'session' ? 'web' : 'api',
    ...(authStrategy === 'access_tokens' ? { tokenExpiresIn: '1d', tokenAbilities: ['*'] } : {}),
    canAccess: async (user, trx) =>
      !(await trx
        .from('role_assignments')
        .where('user_id', user.id)
        .where('role', 'disabled')
        .first()),
  },
  limiterSecret: env.get('APP_KEY').release(),
  // The functional suite sends many requests from one client; production keeps the package
  // default of five requests per 15 minutes.
  ...(app.inTest ? { throttle: { requests: 100, duration: '15m' } } : {}),
  authorize: {
    invite: async (actor, role, context) => role !== 'owner' && isOwner(actor.id, context?.trx),
    manageInvitation: async (actor, _invitation, context) => isOwner(actor.id, context?.trx),
    listInvitations: async (actor) => isOwner(actor.id),
  },
  urls: {
    passwordReset: (token) => accountUrl('password-reset', token),
    emailVerification: (token) => accountUrl('email-verification', token),
    invitation: (token) => accountUrl('invitations', token),
    emailChange: (token) => accountUrl('email-change', token),
  },
  notify: {
    passwordResetProvision: (user, url) => notifications.send('recovery', user.email, url),
    accountActivationProvision: (user, url) =>
      notifications.send('verification', user.unverifiedEmail ?? user.email, url),
    invitationProvision: (invitation, url) =>
      notifications.send('invitation', invitation.email, url),
    emailChangeProvision: (_user, newEmail, url) =>
      notifications.send('emailChangeConfirm', newEmail, url),
    emailChanged: (previousEmail, user) =>
      notifications.send('emailChanged', previousEmail, user.email),
    passwordResetCompleted: (user, context) =>
      notifications.deliverCredentialNotice(context.operationId, context.operation, user.email),
    passwordChanged: (user, context) =>
      notifications.deliverCredentialNotice(context.operationId, context.operation, user.email),
  },
  onInvitationAccepted: async (user: AccountUser, invitation: Invitation, trx: Trx) => {
    await trx.table('role_assignments').insert({ user_id: user.id, role: invitation.role })
  },
  onCredentialsChangedTransaction: async (user, context, trx) => {
    if (context.operation !== 'password_reset' && context.operation !== 'password_change') return

    await trx.table('account_kit_outbox').insert({
      user_id: user.id,
      operation: context.operation,
      operation_id: context.operationId,
      recipient_email: user.email,
      created_at: new Date(),
    })
  },
  onLifecycleEvent: async (event) => notifications.recordLifecycle(event),
})
