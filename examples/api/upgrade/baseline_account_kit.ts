/* eslint-disable @unicorn/no-await-expression-member -- Keep Lucid queries inline in the preserved baseline adapter. */

import type { DateTime } from 'luxon'
import env from '#start/env'
import type UserModel from '#models/user'
import { defineConfig } from 'adonisjs-account-kit'
import type { AccountUser, Invitation, Trx } from 'adonisjs-account-kit'
import hash from '@adonisjs/core/services/hash'
import { notifications } from '#services/account_kit_notifications'

const normalizeEmail = (email: string) => email.trim().toLowerCase()
const appUrl = env.get('APP_URL')
const accountUrl = (path: string, token: string) =>
  new URL('/account-kit/' + path + '/' + encodeURIComponent(token), appUrl).toString()

const loadUser = async () => (await import('#models/user')).default
const query = (User: typeof UserModel, trx?: Trx) =>
  trx ? User.query({ client: trx }) : User.query()
const toAccountUser = (user: UserModel): AccountUser => ({
  id: user.id,
  email: user.email,
  hasPassword: user.password !== null,
  emailVerifiedAt: user.emailVerifiedAt,
})

const users = {
  async findByEmail(email: string, trx?: Trx, options?: { forUpdate?: boolean }) {
    const User = await loadUser()
    const builder = query(User, trx).where('email', normalizeEmail(email))
    if (options?.forUpdate) builder.forUpdate()
    const user = await builder.first()
    return user ? toAccountUser(user) : null
  },

  async findById(id: number | string, trx?: Trx, options?: { forUpdate?: boolean }) {
    const User = await loadUser()
    const builder = query(User, trx).where('id', id)
    if (options?.forUpdate) builder.forUpdate()
    const user = await builder.first()
    return user ? toAccountUser(user) : null
  },

  async create(attrs: { email: string; password: string; emailVerifiedAt: DateTime }, trx: Trx) {
    const User = await loadUser()
    const user = new User()
    user.useTransaction(trx)
    user.email = normalizeEmail(attrs.email)
    user.password = attrs.password
    user.emailVerifiedAt = attrs.emailVerifiedAt
    await user.save()
    return toAccountUser(user)
  },

  async setPassword(id: number | string, password: string, trx: Trx) {
    const User = await loadUser()
    const user = await User.query({ client: trx }).where('id', id).first()
    if (!user) return
    user.password = password
    user.useTransaction(trx)
    await user.save()
  },

  async setEmail(id: number | string, email: string, trx: Trx) {
    const User = await loadUser()
    const user = await User.query({ client: trx }).where('id', id).first()
    if (!user) return
    user.email = normalizeEmail(email)
    user.useTransaction(trx)
    await user.save()
  },

  async markEmailVerified(id: number | string, at: DateTime, trx: Trx) {
    const User = await loadUser()
    const user = await User.query({ client: trx }).where('id', id).first()
    if (!user) return
    user.emailVerifiedAt = at
    user.useTransaction(trx)
    await user.save()
  },

  async verifyPassword(id: number | string, password: string, trx: Trx) {
    const User = await loadUser()
    const user = await User.query({ client: trx }).where('id', id).first()
    return typeof user?.password === 'string' && hash.verify(user.password, password)
  },
}

const revokeTokens = async (user: AccountUser) => {
  const User = await loadUser()
  const model = await User.find(user.id)
  if (model) await User.accessTokens.deleteAll(model)
}
const knownActor = async (id: number | string) => Boolean(await (await loadUser()).find(id))

export default defineConfig({
  limiterSecret: env.get('APP_KEY').release(),
  users,
  authorize: {
    invite: async (actor) => knownActor(actor.id),
    manageInvitation: async (actor) => knownActor(actor.id),
    listInvitations: async (actor) => knownActor(actor.id),
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
  },
  onInvitationAccepted: async (user: AccountUser, invitation: Invitation, trx: Trx) => {
    await trx.table('role_assignments').insert({ user_id: user.id, role: invitation.role })
  },
  onCredentialsChanged: revokeTokens,
})
