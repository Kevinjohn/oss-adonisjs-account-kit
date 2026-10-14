import type { DateTime } from 'luxon'
import type { LucidModel } from '@adonisjs/lucid/types/model'
import type { AccountUser, Trx, UserId, UsersAdapter, UsersAdapterMetadata } from '../src/types.js'

export type { UsersAdapterMetadata } from '../src/types.js'

type ModelRow = {
  id: UserId
  email: string
  password: string | null
  emailVerifiedAt: DateTime | null
  useTransaction(trx: Trx): unknown
  save(): Promise<unknown>
}

type Query = {
  where(column: string, value: unknown): Query
  forUpdate(): Query
  first(): Promise<ModelRow | null>
}

type AccountModel = LucidModel & {
  new (): ModelRow
  boot(): void
}

export interface LucidAdapterOptions<Model extends ModelRow = ModelRow> {
  emailConstraint?: string
  mapRegistrationData?: (data: unknown, user: Model) => void | Promise<void>
  verifyPassword?: (hashedPassword: string, password: string) => Promise<boolean>
}

type LucidCreateAttrs = {
  email: string
  password: string
  emailVerifiedAt: DateTime
  registrationData?: unknown
}

type LucidUsersAdapter = UsersAdapter & {
  create(attrs: LucidCreateAttrs, trx: Trx): Promise<AccountUser>
  resolveMetadata(): Promise<UsersAdapterMetadata>
}

export type LucidModelLoader<Model extends ModelRow = ModelRow> = () => Promise<
  LucidModel & (new () => Model)
>

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function toAccountUser(user: ModelRow): AccountUser {
  return {
    id: user.id,
    email: user.email,
    hasPassword: user.password !== null,
    emailVerifiedAt: user.emailVerifiedAt,
  }
}

function query(User: AccountModel, trx?: Trx): Query {
  const createQuery = User.query as unknown as (options?: { client?: Trx }) => Query
  return createQuery.call(User, trx ? { client: trx } : undefined)
}

function assertSafeRegistrationMapping(
  user: ModelRow,
  before: Pick<ModelRow, 'id' | 'email' | 'password' | 'emailVerifiedAt'> & { role: unknown }
): void {
  const values = user as unknown as Record<string, unknown>
  if (
    user.id !== before.id ||
    user.email !== before.email ||
    user.password !== before.password ||
    user.emailVerifiedAt !== before.emailVerifiedAt ||
    values.role !== before.role
  ) {
    throw new Error(
      'account_kit: mapRegistrationData cannot assign id, email, password, emailVerifiedAt, or role'
    )
  }
}

/**
 * Build the package-maintained adapter around an application-owned Lucid model loader.
 * The loader runs only when an adapter operation needs the model, so application models
 * are never imported as a package side effect.
 */
export function createLucidAdapter<Model extends ModelRow>(
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
      throw new Error('account_kit: Lucid user models must use the default database connection')
    }

    const primaryKey = User.primaryKey
    const physicalPrimaryKey = User.$getColumn(primaryKey)?.columnName
    if (primaryKey !== 'id' || physicalPrimaryKey !== 'id') {
      throw new Error(
        'account_kit: Lucid user models must use the id attribute mapped to the id column'
      )
    }
    if (!User.table) throw new Error('account_kit: Lucid user model must define a table')

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
    change: (user: ModelRow) => void
  ): Promise<void> => {
    const User = await model()
    const user = await find(query(User, trx), 'id', id)
    if (!user) return
    change(user)
    user.useTransaction(trx)
    await user.save()
  }

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
      const user = new User() as unknown as ModelRow
      const before = {
        id: user.id,
        email: user.email,
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
      user.password = attrs.password
      user.emailVerifiedAt = attrs.emailVerifiedAt
      user.useTransaction(trx)
      await user.save()
      return toAccountUser(user)
    },

    async setPassword(id, password, trx) {
      await updateUser(id, trx, (user) => {
        user.password = password
      })
    },

    async setEmail(id, email, trx) {
      await updateUser(id, trx, (user) => {
        user.email = normalizeEmail(email)
      })
    },

    async markEmailVerified(id, at, trx) {
      await updateUser(id, trx, (user) => {
        user.emailVerifiedAt = at
      })
    },

    async verifyPassword(id, password, trx) {
      const user = await find(query(await model(), trx), 'id', id)
      if (typeof user?.password !== 'string') return false
      if (options.verifyPassword) return options.verifyPassword(user.password, password)
      const { default: hash } = await import('@adonisjs/core/services/hash')
      return hash.verify(user.password, password)
    },
  }

  return adapter
}
