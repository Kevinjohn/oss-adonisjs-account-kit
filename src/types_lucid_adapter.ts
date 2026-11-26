import type { DateTime } from 'luxon'
import type { LucidModel } from '@adonisjs/lucid/types/model'
import type {
  AccountUser,
  Trx,
  UserId,
  UsersAdapter,
  UsersAdapterMetadata,
} from './types_foundation.ts'

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

/** Options for `createLucidAdapter`. */
export interface LucidAdapterOptions<Model extends LucidModelRow = LucidModelRow> {
  /** The name of the unique email constraint, when it is not the default. */
  emailConstraint?: string
  /**
   * Assigns validated extra signup fields to the new model. `data` is untrusted request input;
   * never spread it onto the model.
   */
  mapRegistrationData?: (data: unknown, user: Model) => void | Promise<void>
  /** Checks a password against the stored hash. Defaults to the AdonisJS hash service. */
  verifyPassword?: (hashedPassword: string, password: string) => Promise<boolean>
  /**
   * Hashes a new password before Account Kit opens its write transaction. Defaults to the AdonisJS
   * hash service, unless `verifyPassword` is set alone: then the model's own hook hashes inside
   * the transaction, as before.
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
   *
   * @example
   * ```ts
   * await users.create({ email: 'sam@example.test', unverifiedEmail: null, password }, trx)
   * ```
   */
  create(attrs: LucidCreateAttributes, trx: Trx): Promise<AccountUser>
  /**
   * The model's table name, primary key and email constraint.
   *
   * @example
   * ```ts
   * const metadata = await lucidUsers.resolveMetadata()
   * ```
   */
  resolveMetadata(): Promise<UsersAdapterMetadata>
}

/**
 * Loads your Lucid user model lazily, for example `async () => (await
 * import('#models/user')).default`. The adapter caches the first returned promise, including
 * rejection. Later operations reuse that result; this loader is not retried by the adapter.
 */
export type LucidModelLoader<Model extends LucidModelRow = LucidModelRow> = () => Promise<
  LucidModel & (new () => Model)
>
