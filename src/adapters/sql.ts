import type {
  RegistrationColumns,
  RegistrationContext,
  SqlUsersAdapterOptions,
  SqlUsersAdapter,
} from '../types_sql_adapters.ts'
import { InvalidArgumentsException, RuntimeException } from '@adonisjs/core/exceptions'
import type { Database } from '@adonisjs/lucid/database'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from '../errors.ts'
import { isSqlIdentifier } from '../sql_identifier.ts'
import { normalizeEmail } from '../email.ts'
import { readTimestamp, sqlTimestamp } from '../timestamps.ts'
import type { AccountUser, Trx, UserId } from '../types.ts'

export type { UsersAdapterMetadata } from '../types.ts'

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
 *
 * @example
 * ```ts
 * import { createSqlUsersAdapter } from '@kevinjohn/adonisjs-account-kit/adapters/sql'
 *
 * const users = createSqlUsersAdapter({ table: 'users' })
 * ```
 */
export function createSqlUsersAdapter(options: SqlUsersAdapterOptions): SqlUsersAdapter {
  return new SqlUsersAdapterInstance(options)
}

class SqlUsersAdapterInstance implements SqlUsersAdapter {
  #options: SqlUsersAdapterOptions
  #table: string

  constructor(options: SqlUsersAdapterOptions) {
    this.#options = options
    const { table } = options
    if (typeof table !== 'string' || !isSqlIdentifier(table))
      throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
        'table',
        'account_kit: the users table must be a plain SQL identifier'
      )
    this.#table = table
  }

  async #resolveDatabase(): Promise<Database> {
    if (typeof this.#options.db === 'function') return this.#options.db()
    if (this.#options.db) return this.#options.db
    const { default: db } = await import('@adonisjs/lucid/services/db')
    return db
  }
  async #resolveQueryClient(trx?: Trx): Promise<QueryClientContract> {
    if (trx) return trx
    const db = await this.#resolveDatabase()
    return db.connection()
  }
  async #hash(password: string): Promise<string> {
    if (this.#options.hashPassword) return this.#options.hashPassword(password)
    const { default: hasher } = await import('@adonisjs/core/services/hash')
    return hasher.make(password)
  }
  async #verify(hashed: string, password: string): Promise<boolean> {
    if (this.#options.verifyPassword) return this.#options.verifyPassword(hashed, password)
    const { default: hasher } = await import('@adonisjs/core/services/hash')
    return hasher.verify(hashed, password)
  }
  async #mapRegistrationColumns(
    data: unknown,
    context: RegistrationContext
  ): Promise<RegistrationColumns> {
    if (!this.#options.mapRegistrationData)
      throw new InvalidArgumentsException(
        'account_kit: registrationData requires mapRegistrationData'
      )
    const columns = await this.#options.mapRegistrationData(data, context)
    if (!columns || typeof columns !== 'object' || Array.isArray(columns))
      throw new InvalidArgumentsException(
        'account_kit: mapRegistrationData must return an object of columns'
      )
    for (const key of Object.keys(columns)) {
      if (!isSqlIdentifier(key) || controlledColumns.has(key.toLowerCase()))
        throw new InvalidArgumentsException(
          'account_kit: mapRegistrationData cannot assign id, email, unverified_email, password, email_verified_at, credentials_changed_at, or role'
        )
    }
    return columns
  }
  async #getUserByColumn(column: 'id' | 'email', value: UserId, trx?: Trx) {
    const query = await this.#resolveQueryClient(trx)
    return toAccountUser(
      await query.from(this.#table).select(userColumns).where(column, value).first()
    )
  }
  async #update(id: UserId, values: Record<string, unknown>, trx: Trx) {
    await trx.from(this.#table).where('id', id).update(values)
  }

  resolveMetadata: SqlUsersAdapter['resolveMetadata'] = async () => {
    return {
      table: this.#table,
      primaryKey: 'id',
      ...(this.#options.emailConstraint ? { emailConstraint: this.#options.emailConstraint } : {}),
    }
  }

  findByEmail: SqlUsersAdapter['findByEmail'] = async (email, trx) => {
    return this.#getUserByColumn('email', normalizeEmail(email), trx)
  }

  findById: SqlUsersAdapter['findById'] = async (id, trx) => {
    return this.#getUserByColumn('id', id, trx)
  }

  create: SqlUsersAdapter['create'] = async (attrs, trx) => {
    const extra =
      attrs.registrationData === undefined
        ? {}
        : await this.#mapRegistrationColumns(attrs.registrationData, { operation: 'create' })
    const email = normalizeEmail(attrs.email)
    await trx.table(this.#table).insert({
      ...extra,
      ...(this.#options.generateId ? { id: this.#options.generateId() } : {}),
      email,
      unverified_email:
        attrs.unverifiedEmail === null ? null : normalizeEmail(attrs.unverifiedEmail),
      password:
        attrs.passwordHash ?? (attrs.password === null ? null : await this.#hash(attrs.password)),
      email_verified_at: null,
    })
    // Re-read inside the transaction rather than relying on RETURNING or an insert id.
    const created = await this.#getUserByColumn('email', email, trx)
    if (!created) throw new RuntimeException('account_kit: the created user could not be read back')
    return created
  }

  setPassword: SqlUsersAdapter['setPassword'] = async (id, password, trx) => {
    await this.#update(id, { password: await this.#hash(password) }, trx)
  }

  hashPassword: SqlUsersAdapter['hashPassword'] = async (password) => {
    return this.#hash(password)
  }

  setPasswordHash: SqlUsersAdapter['setPasswordHash'] = async (id, passwordHash, trx) => {
    await this.#update(id, { password: passwordHash }, trx)
  }

  setEmail: SqlUsersAdapter['setEmail'] = async (id, email, trx) => {
    await this.#update(id, { email: normalizeEmail(email) }, trx)
  }

  setUnverifiedEmail: SqlUsersAdapter['setUnverifiedEmail'] = async (id, email, trx) => {
    await this.#update(id, { unverified_email: email === null ? null : normalizeEmail(email) }, trx)
  }

  updateRegistrationData: SqlUsersAdapter['updateRegistrationData'] = async (id, data, trx) => {
    const columns = await this.#mapRegistrationColumns(data, { operation: 'update', id })
    if (Object.keys(columns).length > 0) await this.#update(id, columns, trx)
  }

  markEmailVerified: SqlUsersAdapter['markEmailVerified'] = async (id, at, trx) => {
    await this.#update(
      id,
      { unverified_email: null, email_verified_at: sqlTimestamp(trx, at) },
      trx
    )
  }

  delete: SqlUsersAdapter['delete'] = async (id, trx) => {
    await trx.from(this.#table).where('id', id).delete()
  }

  verifyPassword: SqlUsersAdapter['verifyPassword'] = async (id, password, trx) => {
    const row = await trx.from(this.#table).select('password').where('id', id).first()
    if (typeof row?.password !== 'string') return false
    return this.#verify(row.password, password)
  }
}

export type {
  RegistrationColumns,
  RegistrationContext,
  SqlUsersAdapterOptions,
  SqlUsersAdapter,
} from '../types_sql_adapters.ts'
