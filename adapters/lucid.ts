import type { DateTime } from 'luxon'
import type { LucidModel } from '@adonisjs/lucid/types/model'
import { InvalidConfigurationError } from '../src/errors.js'
import { normalizeEmail } from '../src/email.js'
import type { AccountUser, Trx, UserId, UsersAdapter, UsersAdapterMetadata } from '../src/types.js'

export type { UsersAdapterMetadata } from '../src/types.js'

/** The columns and methods the Lucid adapter needs on your user model. */
export type LucidModelRow = {
  id: UserId
  email: string
  unverifiedEmail: string | null
  password: string | null
  emailVerifiedAt: DateTime | null
  /** Bind the row to the transaction its next `save` or `delete` runs in. */
  useTransaction(trx: Trx): unknown
  /** Persist the row's changed attributes. */
  save(): Promise<unknown>
  /** Delete the row. */
  delete(): Promise<unknown>
  /** Physically delete the row through its bound transaction, preserving model hooks. */
  forceDelete?(): Promise<unknown>
}

type Query = {
  where(column: string, value: unknown): Query
  forUpdate(): Query
  first(): Promise<LucidModelRow | null>
}

type AccountModel = LucidModel & {
  new (): LucidModelRow
  boot(): void
}

/** Options for `createLucidAdapter`. */
export interface LucidAdapterOptions<Model extends LucidModelRow = LucidModelRow> {
  /** The name of the unique email constraint, when it is not the default. */
  emailConstraint?: string
  /**
   * Assigns validated extra signup fields to the new model. `data` is untrusted request input;
   * never spread it onto the model.
   */
  mapRegistrationData?: (data: unknown, user: Model) => void | Promise<void>
  /**
   * Checks a password against the stored hash. Defaults to the model's `withAuthFinder` hasher
   * when the model uses it, otherwise the AdonisJS hash service.
   */
  verifyPassword?: (hashedPassword: string, password: string) => Promise<boolean>
  /**
   * Hashes a new password before Account Kit opens its write transaction. Defaults to the model's
   * `withAuthFinder` hasher when the model uses it, otherwise the AdonisJS hash service, unless
   * `verifyPassword` is set alone: then the model's own hook hashes inside the transaction.
   */
  hashPassword?: (password: string) => Promise<string>
}

/** The fields Account Kit passes when it creates a user through the Lucid adapter. */
export type LucidCreateAttributes = {
  email: string
  unverifiedEmail: string | null
  password: string | null
  passwordHash?: string
  registrationData?: unknown
}

/** The users adapter `createLucidAdapter` returns: the base contract plus creation and metadata. */
export type LucidUsersAdapter = UsersAdapter & {
  /**
   * Inserts through the model so its save hooks run. Prepared hashes bypass model password
   * hashing; the verify-only compatibility path lets the model hash the supplied password.
   */
  create(attrs: LucidCreateAttributes, trx: Trx): Promise<AccountUser>
  /** The model's table name, primary key and email constraint. */
  resolveMetadata(): Promise<UsersAdapterMetadata>
}

/**
 * Loads your Lucid user model lazily, for example `async () => (await
 * import('#models/user')).default`.
 */
export type LucidModelLoader<Model extends LucidModelRow = LucidModelRow> = () => Promise<
  LucidModel & (new () => Model)
>

/** The statics `withAuthFinder` from `@adonisjs/auth` adds to a model. */
type AuthFinderModel = {
  hashPassword(user: { $dirty: Record<string, unknown>; password: string }): Promise<void>
  findForAuth(...args: unknown[]): unknown
  verifyCredentials(...args: unknown[]): unknown
}

/** The `withAuthFinder` statics, when the model uses that mixin. */
function authFinder(User: unknown): AuthFinderModel | null {
  const model = User as Partial<AuthFinderModel>
  return typeof model.hashPassword === 'function' &&
    typeof model.findForAuth === 'function' &&
    typeof model.verifyCredentials === 'function'
    ? (model as AuthFinderModel)
    : null
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
  }
): void {
  const values = user as unknown as Record<string, unknown>
  if (
    user.id !== before.id ||
    user.email !== before.email ||
    user.unverifiedEmail !== before.unverifiedEmail ||
    user.password !== before.password ||
    user.emailVerifiedAt !== before.emailVerifiedAt ||
    values.role !== before.role
  ) {
    throw new Error(
      'account_kit: mapRegistrationData cannot assign id, email, unverifiedEmail, password, emailVerifiedAt, or role'
    )
  }
}

/**
 * Build the package-maintained adapter around an application-owned Lucid model loader.
 * The loader runs only when an adapter operation needs the model, so application models
 * are never imported as a package side effect.
 */
export function createLucidAdapter<Model extends LucidModelRow>(
  loadModel: LucidModelLoader<Model>,
  options: LucidAdapterOptions<Model> = {}
): LucidUsersAdapter {
  let modelPromise: Promise<AccountModel> | undefined
  const model = async (): Promise<AccountModel> => {
    modelPromise ??= loadModel().then((User) => User as unknown as AccountModel)
    const User = await modelPromise
    metadataFor(User)
    return User
  }

  const metadataFor = (User: AccountModel): UsersAdapterMetadata => {
    User.boot()

    if (User.connection) {
      throw new InvalidConfigurationError(
        'model.connection',
        'account_kit: Lucid user models must use the default database connection'
      )
    }

    const primaryKey = User.primaryKey
    const physicalPrimaryKey = User.$getColumn(primaryKey)?.columnName
    if (primaryKey !== 'id' || physicalPrimaryKey !== 'id') {
      throw new InvalidConfigurationError(
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
        throw new InvalidConfigurationError(
          `model.columns.${attribute}`,
          `account_kit: Lucid user models must use the ${attribute} attribute mapped to the ${column} column`
        )
      }
    }
    if (!User.table)
      throw new InvalidConfigurationError(
        'model.table',
        'account_kit: Lucid user model must define a table'
      )

    return {
      table: User.table,
      primaryKey: 'id',
      ...(options.emailConstraint ? { emailConstraint: options.emailConstraint } : {}),
    }
  }

  const resolveMetadata = async (): Promise<UsersAdapterMetadata> => metadataFor(await model())

  const find = async (builder: Query, column: string, value: unknown, forUpdate = false) => {
    const filtered = builder.where(column, value)
    if (forUpdate) filtered.forUpdate()
    return filtered.first()
  }

  const updateUser = async (
    id: UserId,
    trx: Trx,
    change: (user: LucidModelRow) => void
  ): Promise<void> => {
    const User = await model()
    const user = await find(query(User, trx), 'id', id)
    if (!user) return
    change(user)
    user.useTransaction(trx)
    await user.save()
  }

  // A ready hash is written with a query, not the model, so the model's hashing hook never sees it.
  const writeHash = async (id: UserId, passwordHash: string, trx: Trx): Promise<void> => {
    const User = await model()
    const update = (
      User.query as unknown as (options: { client: Trx }) => {
        where(column: string, value: unknown): { update(values: object): Promise<unknown> }
      }
    ).call(User, { client: trx })
    await update.where('id', id).update({ password: passwordHash })
  }

  const hashPassword =
    options.hashPassword ??
    (options.verifyPassword
      ? undefined
      : async (password: string): Promise<string> => {
          // Hash with the model's own hasher, so the application's `verifyCredentials` agrees.
          const finder = authFinder(await model())
          if (finder) {
            const row = { $dirty: { password: true }, password }
            await finder.hashPassword(row)
            return row.password
          }
          const { default: hash } = await import('@adonisjs/core/services/hash')
          return hash.make(password)
        })

  const adapter: LucidUsersAdapter = {
    async resolveMetadata() {
      return resolveMetadata()
    },

    async findByEmail(email, trx, findOptions) {
      const user = await find(
        query(await model(), trx),
        'email',
        normalizeEmail(email),
        findOptions?.forUpdate
      )
      return user ? toAccountUser(user) : null
    },

    async findById(id, trx, findOptions) {
      const user = await find(query(await model(), trx), 'id', id, findOptions?.forUpdate)
      return user ? toAccountUser(user) : null
    },

    async create(attrs, trx) {
      const User = await model()
      const user = new User() as unknown as LucidModelRow
      const before = {
        id: user.id,
        email: user.email,
        unverifiedEmail: user.unverifiedEmail,
        password: user.password,
        emailVerifiedAt: user.emailVerifiedAt,
        role: (user as unknown as Record<string, unknown>).role,
      }

      if (attrs.registrationData !== undefined) {
        if (!options.mapRegistrationData) {
          throw new Error('account_kit: registrationData requires mapRegistrationData')
        }
        await options.mapRegistrationData(attrs.registrationData, user as Model)
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
        await writeHash(user.id, attrs.passwordHash, trx)
        user.password = attrs.passwordHash
      }
      return toAccountUser(user)
    },

    async setPassword(id, password, trx) {
      await updateUser(id, trx, (user) => {
        user.password = password
      })
    },

    ...(hashPassword
      ? {
          hashPassword,
          async setPasswordHash(id: UserId, passwordHash: string, trx: Trx) {
            await writeHash(id, passwordHash, trx)
          },
        }
      : {}),

    async setEmail(id, email, trx) {
      await updateUser(id, trx, (user) => {
        user.email = normalizeEmail(email)
      })
    },

    async setUnverifiedEmail(id, email, trx) {
      await updateUser(id, trx, (user) => {
        user.unverifiedEmail = email === null ? null : normalizeEmail(email)
      })
    },

    async updateRegistrationData(id, data, trx) {
      if (!options.mapRegistrationData)
        throw new Error('account_kit: registrationData requires mapRegistrationData')
      const User = await model()
      const user = await find(query(User, trx), 'id', id)
      if (!user) return
      const before = {
        id: user.id,
        email: user.email,
        unverifiedEmail: user.unverifiedEmail,
        password: user.password,
        emailVerifiedAt: user.emailVerifiedAt,
        role: (user as unknown as Record<string, unknown>).role,
      }
      await options.mapRegistrationData(data, user as Model)
      assertSafeRegistrationMapping(user, before)
      user.useTransaction(trx)
      await user.save()
    },

    async markEmailVerified(id, at, trx) {
      await updateUser(id, trx, (user) => {
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
    },

    async verifyPassword(id, password, trx) {
      const user = await find(query(await model(), trx), 'id', id)
      if (typeof user?.password !== 'string') return false
      if (options.verifyPassword) return options.verifyPassword(user.password, password)
      const withFinder = user as LucidModelRow & {
        verifyPassword?(plain: string): Promise<boolean>
      }
      if (authFinder(await model()) && typeof withFinder.verifyPassword === 'function')
        return withFinder.verifyPassword(password)
      const { default: hash } = await import('@adonisjs/core/services/hash')
      return hash.verify(user.password, password)
    },

    async delete(id, trx) {
      const user = await find(query(await model(), trx), 'id', id)
      if (!user) return
      user.useTransaction(trx)
      if (typeof user.forceDelete === 'function') await user.forceDelete()
      else await user.delete()
    },
  }

  return adapter
}
