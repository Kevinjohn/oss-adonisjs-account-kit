import { DateTime } from 'luxon'
import type { Hash } from '@adonisjs/core/hash'
import type { Database } from '@adonisjs/lucid/database'
import type {
  AccountKitConfig,
  AccountUser,
  Invitation,
  Trx,
  UserId,
  UsersAdapter,
} from '../../src/types.js'

export function makeUsersAdapter(db: Database, hash: Hash): UsersAdapter {
  const query = (trx?: Trx) => trx ?? db.connection()
  const toUser = (row: Record<string, unknown> | undefined): AccountUser | null =>
    row
      ? {
          id: row.id as UserId,
          email: row.email as string,
          hasPassword: row.password !== null,
          emailVerifiedAt: row.email_verified_at
            ? DateTime.fromJSDate(new Date(row.email_verified_at as string), { zone: 'utc' })
            : null,
        }
      : null
  return {
    async findByEmail(email, trx, options) {
      const builder = query(trx).from('users').where('email', email.trim().toLowerCase())
      if (options?.forUpdate) builder.forUpdate()
      return toUser(await builder.first())
    },
    async findById(id, trx, options) {
      const builder = query(trx).from('users').where('id', id)
      if (options?.forUpdate) builder.forUpdate()
      return toUser(await builder.first())
    },
    async create(attrs, trx) {
      const [id] = await trx
        .table('users')
        .insert({
          email: attrs.email.trim().toLowerCase(),
          password: await hash.make(attrs.password),
          email_verified_at: attrs.emailVerifiedAt.toISO(),
          created_at: DateTime.utc().toISO(),
        })
        .returning('id')
      return (await this.findById(typeof id === 'object' ? id.id : id, trx))!
    },
    async setPassword(id, password, trx) {
      await trx
        .from('users')
        .where('id', id)
        .update({ password: await hash.make(password) })
    },
    async setEmail(id, email, trx) {
      await trx.from('users').where('id', id).update({ email: email.trim().toLowerCase() })
    },
    async markEmailVerified(id, at, trx) {
      await trx.from('users').where('id', id).update({ email_verified_at: at.toISO() })
    },
    async verifyPassword(id, password, trx) {
      const row = await trx.from('users').where('id', id).first()
      return typeof row?.password === 'string' && (await hash.verify(row.password, password))
    },
  }
}

export type NotifyCall = { method: keyof AccountKitConfig['notify']; args: unknown[] }
export function makeNotify() {
  const calls: NotifyCall[] = []
  let failing: keyof AccountKitConfig['notify'] | null = null
  const record = async (method: NotifyCall['method'], ...args: unknown[]) => {
    calls.push({ method, args })
    if (failing === method) throw new Error(`notify.${method} failed`)
  }
  const notify: AccountKitConfig['notify'] = {
    recovery: (user, url) => record('recovery', user, url),
    verification: (user, url) => record('verification', user, url),
    invitation: (invitation, url) => record('invitation', invitation, url),
    emailChangeConfirm: (user, newEmail, url) => record('emailChangeConfirm', user, newEmail, url),
    emailChanged: (previousEmail, user) => record('emailChanged', previousEmail, user),
  }
  return {
    notify,
    calls,
    failOn(method: keyof AccountKitConfig['notify'] | null) {
      failing = method
    },
  }
}

const authorize = (value: boolean): AccountKitConfig['authorize'] => ({
  invite: async () => value,
  manageInvitation: async () => value,
  listInvitations: async () => value,
})
export const allowAll = authorize(true)
export const denyAll = authorize(false)

export function makeConfig(
  overrides: Pick<AccountKitConfig, 'users'> & Partial<Omit<AccountKitConfig, 'users'>>
): AccountKitConfig {
  const { notify } = makeNotify()
  return {
    authorize: allowAll,
    urls: {
      recovery: (token) => `https://example.test/recovery/${token}`,
      verification: (token) => `https://example.test/verification/${token}`,
      invitation: (token) => `https://example.test/invitation/${token}`,
      emailChange: (token) => `https://example.test/email-change/${token}`,
    },
    notify,
    onInvitationAccepted: async (_user: AccountUser, _invitation: Invitation, _trx: Trx) => {},
    ...overrides,
  }
}
