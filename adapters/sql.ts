import type { Database } from '@adonisjs/lucid/database'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import { isSqlIdentifier } from '../src/sql_identifier.js'
import { normalizeEmail } from '../src/email.js'
import { readTimestamp, sqlTimestamp } from '../src/timestamps.js'
import type { AccountUser, Trx, UserId, UsersAdapter, UsersAdapterMetadata } from '../src/types.js'

export type { UsersAdapterMetadata } from '../src/types.js'

/** Extra columns for the users row, keyed by physical column name. */
export type RegistrationColumns = Record<string, unknown>

export type RegistrationContext = { operation: 'create' } | { operation: 'update'; id: UserId }

export interface SqlUsersAdapterOptions {
  /** The users table. It must use the columns id, email, unverified_email, password and email_verified_at. */
  table: string
  /** The Lucid database; defaults to the application's `@adonisjs/lucid/services/db`. */
  db?: Database | (() => Promise<Database>)
  /** Defaults to the AdonisJS hash service. */
  hashPassword?: (password: string) => Promise<string>
  /** Defaults to the AdonisJS hash service. */
  verifyPassword?: (hashedPassword: string, password: string) => Promise<boolean>
  /**
   * Validate registration data and return extra columns to write. It may not set id, email,
   * unverified_email, password, email_verified_at, credentials_changed_at or role.
   */
  mapRegistrationData?: (
    data: unknown,
    context: RegistrationContext
  ) => RegistrationColumns | Promise<RegistrationColumns>
  /** Generate the id for string keys that have no database default. */
  generateId?: () => string
  emailConstraint?: string
}

export type SqlUsersAdapter = UsersAdapter & {
  hashPassword: NonNullable<UsersAdapter['hashPassword']>
  setPasswordHash: NonNullable<UsersAdapter['setPasswordHash']>
  updateRegistrationData: NonNullable<UsersAdapter['updateRegistrationData']>
  delete: NonNullable<UsersAdapter['delete']>
  resolveMetadata(): Promise<UsersAdapterMetadata>
}

const controlledColumns = new Set([
  'id',
  'email',
  'unverified_email',
  'password',
  'email_verified_at',
  'credentials_changed_at',
  'role',
])

const userColumns = ['id', 'email', 'unverified_email', 'password', 'email_verified_at']

function toAccountUser(row: Record<string, unknown> | null | undefined): AccountUser | null {
  if (!row) return null
  return {
    id: row.id as UserId,
    email: row.email as string,
    unverifiedEmail: (row.unverified_email as string | null) ?? null,
    hasPassword: row.password !== null && row.password !== undefined,
    emailVerifiedAt: readTimestamp(row.email_verified_at),
  }
}

/**
 * A users adapter that runs plain SQL through the package's Lucid transaction. Use it when the
 * users table is not a Lucid model; the Drizzle and Prisma adapters build on it.
 */
export function createSqlUsersAdapter(options: SqlUsersAdapterOptions): SqlUsersAdapter {
  const { table } = options
  if (typeof table !== 'string' || !isSqlIdentifier(table))
    throw new Error('account_kit: the users table must be a plain SQL identifier')

  const database = async (): Promise<Database> => {
    if (typeof options.db === 'function') return options.db()
    if (options.db) return options.db
    const { default: db } = await import('@adonisjs/lucid/services/db')
    return db
  }
  const client = async (trx?: Trx): Promise<QueryClientContract> => {
    if (trx) return trx
    const db = await database()
    return db.connection()
  }
  const hash = async (password: string): Promise<string> => {
    if (options.hashPassword) return options.hashPassword(password)
    const { default: hasher } = await import('@adonisjs/core/services/hash')
    return hasher.make(password)
  }
  const verify = async (hashed: string, password: string): Promise<boolean> => {
    if (options.verifyPassword) return options.verifyPassword(hashed, password)
    const { default: hasher } = await import('@adonisjs/core/services/hash')
    return hasher.verify(hashed, password)
  }
  const registrationColumns = async (
    data: unknown,
    context: RegistrationContext
  ): Promise<RegistrationColumns> => {
    if (!options.mapRegistrationData)
      throw new Error('account_kit: registrationData requires mapRegistrationData')
    const columns = await options.mapRegistrationData(data, context)
    if (!columns || typeof columns !== 'object' || Array.isArray(columns))
      throw new Error('account_kit: mapRegistrationData must return an object of columns')
    for (const key of Object.keys(columns)) {
      if (!isSqlIdentifier(key) || controlledColumns.has(key.toLowerCase()))
        throw new Error(
          'account_kit: mapRegistrationData cannot assign id, email, unverified_email, password, email_verified_at, credentials_changed_at, or role'
        )
    }
    return columns
  }
  const find = async (column: 'id' | 'email', value: UserId, trx?: Trx) => {
    const query = await client(trx)
    return toAccountUser(await query.from(table).select(userColumns).where(column, value).first())
  }
  const update = async (id: UserId, values: Record<string, unknown>, trx: Trx) => {
    await trx.from(table).where('id', id).update(values)
  }

  return {
    async resolveMetadata() {
      return {
        table,
        primaryKey: 'id',
        ...(options.emailConstraint ? { emailConstraint: options.emailConstraint } : {}),
      }
    },

    async findByEmail(email, trx) {
      return find('email', normalizeEmail(email), trx)
    },

    async findById(id, trx) {
      return find('id', id, trx)
    },

    async create(attrs, trx) {
      const extra =
        attrs.registrationData === undefined
          ? {}
          : await registrationColumns(attrs.registrationData, { operation: 'create' })
      const email = normalizeEmail(attrs.email)
      await trx.table(table).insert({
        ...extra,
        ...(options.generateId ? { id: options.generateId() } : {}),
        email,
        unverified_email:
          attrs.unverifiedEmail === null ? null : normalizeEmail(attrs.unverifiedEmail),
        password:
          attrs.passwordHash ?? (attrs.password === null ? null : await hash(attrs.password)),
        email_verified_at: null,
      })
      // Re-read inside the transaction rather than relying on RETURNING or an insert id.
      const created = await find('email', email, trx)
      if (!created) throw new Error('account_kit: the created user could not be read back')
      return created
    },

    async setPassword(id, password, trx) {
      await update(id, { password: await hash(password) }, trx)
    },

    async hashPassword(password) {
      return hash(password)
    },

    async setPasswordHash(id, passwordHash, trx) {
      await update(id, { password: passwordHash }, trx)
    },

    async setEmail(id, email, trx) {
      await update(id, { email: normalizeEmail(email) }, trx)
    },

    async setUnverifiedEmail(id, email, trx) {
      await update(id, { unverified_email: email === null ? null : normalizeEmail(email) }, trx)
    },

    async updateRegistrationData(id, data, trx) {
      const columns = await registrationColumns(data, { operation: 'update', id })
      if (Object.keys(columns).length > 0) await update(id, columns, trx)
    },

    async markEmailVerified(id, at, trx) {
      await update(id, { unverified_email: null, email_verified_at: sqlTimestamp(trx, at) }, trx)
    },

    async delete(id, trx) {
      await trx.from(table).where('id', id).delete()
    },

    async verifyPassword(id, password, trx) {
      const row = await trx.from(table).select('password').where('id', id).first()
      if (typeof row?.password !== 'string') return false
      return verify(row.password, password)
    },
  }
}
