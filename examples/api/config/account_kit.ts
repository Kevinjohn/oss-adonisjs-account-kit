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

const normalizeBaseUrl = (value: string) => (value.endsWith('/') ? value : `${value}/`)
const appUrl = normalizeBaseUrl(env.get('APP_URL'))
const accountUrl = (path: string, token: string) =>
  new URL(`account-kit/${path}/${encodeURIComponent(token)}`, appUrl).toString()

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
    recovery: (token) => accountUrl('recovery', token),
    verification: (token) => accountUrl('verification', token),
    invitation: (token) => accountUrl('invitation', token),
    emailChange: (token) => accountUrl('email-change', token),
  },
  notify: {
    recovery: (user, url) => notifications.send('recovery', user.email, url),
    verification: (user, url) => notifications.send('verification', user.email, url),
    invitation: (invitation, url) => notifications.send('invitation', invitation.email, url),
    emailChangeConfirm: (_user, newEmail, url) =>
      notifications.send('emailChangeConfirm', newEmail, url),
    emailChanged: (previousEmail, user) =>
      notifications.send('emailChanged', previousEmail, user.email),
    passwordReset: (user, context) =>
      notifications.deliverCredentialNotice(context.operationId, context.operation, user.email),
    passwordChanged: (user, context) =>
      notifications.deliverCredentialNotice(context.operationId, context.operation, user.email),
  },
  onInvitationAccepted: async (user: AccountUser, invitation: Invitation, trx: Trx) => {
    await trx.table('role_assignments').insert({ user_id: user.id, role: invitation.role })
  },
  onCredentialsChangedTransaction: async (user, context, trx) => {
    await trx.from('auth_access_tokens').where('tokenable_id', user.id).delete()
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
