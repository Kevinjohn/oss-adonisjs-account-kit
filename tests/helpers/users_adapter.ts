import { DateTime } from 'luxon'
import type { Hash } from '@adonisjs/core/hash'
import type { Database } from '@adonisjs/lucid/database'
import type { AccountUser, Trx, UserId, UsersAdapter } from '../../src/types.js'

/** `returning('id')` yields a bare id on SQLite and `{ id }` on PostgreSQL. */
export const unwrapId = (value: unknown): UserId =>
  (typeof value === 'object' && value !== null ? (value as { id: UserId }).id : value) as UserId

export function makeUsersAdapter(db: Database, hash: Hash, usersTable = 'users'): UsersAdapter {
  const query = (trx?: Trx) => trx ?? db.connection()
  const toUser = (row: Record<string, unknown> | undefined): AccountUser | null =>
    row
      ? {
          id: row.id as UserId,
          email: row.email as string,
          unverifiedEmail: row.unverified_email as string | null,
          hasPassword: row.password !== null,
          emailVerifiedAt: row.email_verified_at
            ? DateTime.fromJSDate(new Date(row.email_verified_at as string), { zone: 'utc' })
            : null,
        }
      : null
  return {
    async findByEmail(email, trx, options) {
      const builder = query(trx).from(usersTable).where('email', email.trim().toLowerCase())
      if (options?.forUpdate) builder.forUpdate()
      return toUser(await builder.first())
    },
    async findById(id, trx, options) {
      const builder = query(trx).from(usersTable).where('id', id)
      if (options?.forUpdate) builder.forUpdate()
      return toUser(await builder.first())
    },
    async create(attrs, trx) {
      const [id] = await trx
        .table(usersTable)
        .insert({
          email: attrs.email.trim().toLowerCase(),
          unverified_email: attrs.unverifiedEmail,
          password: attrs.password === null ? null : await hash.make(attrs.password),
          email_verified_at: null,
          created_at: DateTime.utc().toISO(),
        })
        .returning('id')
      return (await this.findById(unwrapId(id), trx))!
    },
    async setPassword(id, password, trx) {
      await trx
        .from(usersTable)
        .where('id', id)
        .update({ password: await hash.make(password) })
    },
    async setEmail(id, email, trx) {
      await trx.from(usersTable).where('id', id).update({ email: email.trim().toLowerCase() })
    },
    async setUnverifiedEmail(id, email, trx) {
      await trx
        .from(usersTable)
        .where('id', id)
        .update({ unverified_email: email?.trim().toLowerCase() ?? null })
    },
    async markEmailVerified(id, at, trx) {
      await trx
        .from(usersTable)
        .where('id', id)
        .update({ unverified_email: null, email_verified_at: at.toISO() })
    },
    async verifyPassword(id, password, trx) {
      const row = await trx.from(usersTable).where('id', id).first()
      return typeof row?.password === 'string' && (await hash.verify(row.password, password))
    },
  }
}
