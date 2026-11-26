import type {
  LucidModelRow,
  LucidAdapterOptions,
  LucidUsersAdapter,
  LucidModelLoader,
} from '../types_lucid_adapter.ts'
import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
import type { LucidModel } from '@adonisjs/lucid/types/model'
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from '../errors.ts'
import { normalizeEmail } from '../email.ts'
import type { AccountUser, Trx, UserId, UsersAdapterMetadata } from '../types.ts'

export type { UsersAdapterMetadata } from '../types.ts'

type Query = {
  where(column: string, value: unknown): Query
  where(column: string, operator: string, value: unknown): Query
  select(...columns: string[]): Query
  orderBy(column: string, direction: 'asc' | 'desc'): Query
  limit(value: number): Query
  exec(): Promise<LucidModelRow[]>
  first(): Promise<LucidModelRow | null>
}

type AccountModel = LucidModel & {
  new (): LucidModelRow
  boot(): void
}

function toAccountUser(user: LucidModelRow): AccountUser {
  return {
    id: user.id,
    email: user.email,
    unverifiedEmail: user.unverifiedEmail,
    hasPassword: user.password !== null,
    emailVerifiedAt: user.emailVerifiedAt,
  }
}

function query(User: AccountModel, trx?: Trx): Query {
  const createQuery = User.query as unknown as (options?: { client?: Trx }) => Query
  return createQuery.call(User, trx ? { client: trx } : undefined)
}

function assertSafeRegistrationMapping(
  user: LucidModelRow,
  before: Pick<
    LucidModelRow,
    'id' | 'email' | 'unverifiedEmail' | 'password' | 'emailVerifiedAt'
  > & {
    role: unknown
    credentialsChangedAt: unknown
  }
): void {
  const values = user as unknown as Record<string, unknown>
  if (
    user.id !== before.id ||
    user.email !== before.email ||
    user.unverifiedEmail !== before.unverifiedEmail ||
    user.password !== before.password ||
    user.emailVerifiedAt !== before.emailVerifiedAt ||
    values.role !== before.role ||
    values.credentialsChangedAt !== before.credentialsChangedAt
  ) {
    throw new InvalidArgumentsException(
      'account_kit: mapRegistrationData cannot assign id, email, unverifiedEmail, password, emailVerifiedAt, credentialsChangedAt, or role'
    )
  }
}

/**
 * Build the package-maintained adapter around an application-owned Lucid model loader.
 * The loader runs only when an adapter operation needs the model, so application models
 * are never imported as a package side effect.
 *
 * @example
 * ```ts
 * import { createLucidAdapter } from '@kevinjohn/adonisjs-account-kit/adapters/lucid'
 *
 * const users = createLucidAdapter(async () => (await import('#models/user')).default)
 * ```
 */
export function createLucidAdapter<Model extends LucidModelRow>(
  loadModel: LucidModelLoader<Model>,
  options: LucidAdapterOptions<Model> = {}
): LucidUsersAdapter {
  return new LucidUsersAdapterInstance(loadModel, options)
}

class LucidUsersAdapterInstance<Model extends LucidModelRow> implements LucidUsersAdapter {
  #loadModel: LucidModelLoader<Model>
  #options: LucidAdapterOptions<Model>
  #modelPromise: Promise<AccountModel> | undefined

  declare hashPassword?: LucidUsersAdapter['hashPassword']
  declare setPasswordHash?: LucidUsersAdapter['setPasswordHash']

  constructor(loadModel: LucidModelLoader<Model>, options: LucidAdapterOptions<Model>) {
    this.#loadModel = loadModel
    this.#options = options
    const hashPassword =
      options.hashPassword ??
      (options.verifyPassword
        ? undefined
        : async (password: string): Promise<string> => {
            const { default: hash } = await import('@adonisjs/core/services/hash')
            return hash.make(password)
          })
    if (hashPassword) {
      this.hashPassword = hashPassword
      this.setPasswordHash = async (id, passwordHash, trx) => {
        await this.#writeHash(id, passwordHash, trx)
      }
    }
  }

  async #loadUserModel(): Promise<AccountModel> {
    const loadModel = this.#loadModel
    this.#modelPromise ??= loadModel().then((User) => User as unknown as AccountModel)
    const User = await this.#modelPromise
    this.#readUserModelMetadata(User)
    return User
  }

  #readUserModelMetadata(User: AccountModel): UsersAdapterMetadata {
    User.boot()

    if (User.connection) {
      throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
        'model.connection',
        'account_kit: Lucid user models must use the default database connection'
      )
    }

    const primaryKey = User.primaryKey
    const physicalPrimaryKey = User.$getColumn(primaryKey)?.columnName
    if (primaryKey !== 'id' || physicalPrimaryKey !== 'id') {
      throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
        'model.primaryKey',
        'account_kit: Lucid user models must use the id attribute mapped to the id column'
      )
    }
    for (const [attribute, column] of [
      ['email', 'email'],
      ['unverifiedEmail', 'unverified_email'],
      ['password', 'password'],
      ['emailVerifiedAt', 'email_verified_at'],
    ] as const) {
      if (User.$getColumn(attribute)?.columnName !== column) {
        throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
          `model.columns.${attribute}`,
          `account_kit: Lucid user models must use the ${attribute} attribute mapped to the ${column} column`
        )
      }
    }
    if (!User.table)
      throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
        'model.table',
        'account_kit: Lucid user model must define a table'
      )

    return {
      table: User.table,
      primaryKey: 'id',
      ...(this.#options.emailConstraint ? { emailConstraint: this.#options.emailConstraint } : {}),
    }
  }

  async #getByColumn(builder: Query, column: string, value: unknown) {
    return builder.where(column, value).first()
  }

  async #updateUser(id: UserId, trx: Trx, change: (user: LucidModelRow) => void): Promise<void> {
    const User = await this.#loadUserModel()
    const user = await this.#getByColumn(query(User, trx), 'id', id)
    if (!user) return
    change(user)
    user.useTransaction(trx)
    await user.save()
  }

  // A ready hash is written with a query, not the model, so the model's hashing hook never sees it.
  async #writeHash(id: UserId, passwordHash: string, trx: Trx): Promise<void> {
    const User = await this.#loadUserModel()
    const update = (
      User.query as unknown as (options: { client: Trx }) => {
        where(column: string, value: unknown): { update(values: object): Promise<unknown> }
      }
    ).call(User, { client: trx })
    await update.where('id', id).update({ password: passwordHash })
  }

  resolveMetadata: LucidUsersAdapter['resolveMetadata'] = async () => {
    return this.#readUserModelMetadata(await this.#loadUserModel())
  }

  findByEmail: LucidUsersAdapter['findByEmail'] = async (email, trx) => {
    const user = await this.#getByColumn(
      query(await this.#loadUserModel(), trx),
      'email',
      normalizeEmail(email)
    )
    return user ? toAccountUser(user) : null
  }

  findById: LucidUsersAdapter['findById'] = async (id, trx) => {
    const user = await this.#getByColumn(query(await this.#loadUserModel(), trx), 'id', id)
    return user ? toAccountUser(user) : null
  }

  listVisibleIds: NonNullable<LucidUsersAdapter['listVisibleIds']> = async (after, limit) => {
    const listing = query(await this.#loadUserModel())
    if (after !== undefined) listing.where('id', '>', after)
    const users = await listing.select('id').orderBy('id', 'asc').limit(limit).exec()
    return users.map(({ id }) => id)
  }

  create: LucidUsersAdapter['create'] = async (attrs, trx) => {
    const User = await this.#loadUserModel()
    const user = new User() as unknown as LucidModelRow
    const before = {
      id: user.id,
      email: user.email,
      unverifiedEmail: user.unverifiedEmail,
      password: user.password,
      emailVerifiedAt: user.emailVerifiedAt,
      role: (user as unknown as Record<string, unknown>).role,
      credentialsChangedAt: (user as unknown as Record<string, unknown>).credentialsChangedAt,
    }

    if (attrs.registrationData !== undefined) {
      if (!this.#options.mapRegistrationData) {
        throw new InvalidArgumentsException(
          'account_kit: registrationData requires mapRegistrationData'
        )
      }
      await this.#options.mapRegistrationData(attrs.registrationData, user as Model)
      assertSafeRegistrationMapping(user, before)
    }

    user.email = normalizeEmail(attrs.email)
    user.unverifiedEmail =
      attrs.unverifiedEmail === null ? null : normalizeEmail(attrs.unverifiedEmail)
    user.password = attrs.passwordHash === undefined ? attrs.password : null
    user.emailVerifiedAt = null
    user.useTransaction(trx)
    await user.save()
    if (attrs.passwordHash !== undefined) {
      await this.#writeHash(user.id, attrs.passwordHash, trx)
      user.password = attrs.passwordHash
    }
    return toAccountUser(user)
  }

  setPassword: LucidUsersAdapter['setPassword'] = async (id, password, trx) => {
    await this.#updateUser(id, trx, (user) => {
      user.password = password
    })
  }

  setEmail: LucidUsersAdapter['setEmail'] = async (id, email, trx) => {
    await this.#updateUser(id, trx, (user) => {
      user.email = normalizeEmail(email)
    })
  }

  setUnverifiedEmail: LucidUsersAdapter['setUnverifiedEmail'] = async (id, email, trx) => {
    await this.#updateUser(id, trx, (user) => {
      user.unverifiedEmail = email === null ? null : normalizeEmail(email)
    })
  }

  updateRegistrationData: NonNullable<LucidUsersAdapter['updateRegistrationData']> = async (
    id,
    data,
    trx
  ) => {
    if (!this.#options.mapRegistrationData)
      throw new InvalidArgumentsException(
        'account_kit: registrationData requires mapRegistrationData'
      )
    const User = await this.#loadUserModel()
    const user = await this.#getByColumn(query(User, trx), 'id', id)
    if (!user) return
    const before = {
      id: user.id,
      email: user.email,
      unverifiedEmail: user.unverifiedEmail,
      password: user.password,
      emailVerifiedAt: user.emailVerifiedAt,
      role: (user as unknown as Record<string, unknown>).role,
      credentialsChangedAt: (user as unknown as Record<string, unknown>).credentialsChangedAt,
    }
    await this.#options.mapRegistrationData(data, user as Model)
    assertSafeRegistrationMapping(user, before)
    user.useTransaction(trx)
    await user.save()
  }

  markEmailVerified: LucidUsersAdapter['markEmailVerified'] = async (id, at, trx) => {
    await this.#updateUser(id, trx, (user) => {
      user.unverifiedEmail = null
      // Lucid writes MySQL and SQLite timestamps as wall time without an offset. mysql2 with the
      // required `timezone: 'Z'` reads MySQL back as UTC; Lucid reads SQLite back in the
      // process zone, so SQLite gets local wall time.
      user.emailVerifiedAt =
        trx.dialect.name === 'mysql'
          ? at.toUTC()
          : ['better-sqlite3', 'sqlite3'].includes(trx.dialect.name)
            ? at.toLocal()
            : at
    })
  }

  verifyPassword: LucidUsersAdapter['verifyPassword'] = async (id, password, trx) => {
    const user = await this.#getByColumn(query(await this.#loadUserModel(), trx), 'id', id)
    if (typeof user?.password !== 'string') return false
    if (this.#options.verifyPassword) return this.#options.verifyPassword(user.password, password)
    const { default: hash } = await import('@adonisjs/core/services/hash')
    return hash.verify(user.password, password)
  }

  delete: NonNullable<LucidUsersAdapter['delete']> = async (id, trx) => {
    const user = await this.#getByColumn(query(await this.#loadUserModel(), trx), 'id', id)
    if (!user) return
    user.useTransaction(trx)
    if (typeof user.forceDelete === 'function') await user.forceDelete()
    else await user.delete()
  }
}

export type {
  LucidModelRow,
  LucidAdapterOptions,
  LucidCreateAttributes,
  LucidUsersAdapter,
  LucidModelLoader,
} from '../types_lucid_adapter.ts'
