import type { Database } from '@adonisjs/lucid/database'
import type { UserId, UsersAdapter, UsersAdapterMetadata } from './types_foundation.ts'

/** Extra columns for the users row, keyed by physical column name. */
export type RegistrationColumns = Record<string, unknown>

/** Whether the SQL adapter is mapping registration data for a new or existing account. */
export type RegistrationContext = { operation: 'create' } | { operation: 'update'; id: UserId }

/** Options for a users adapter backed by the application’s Lucid database. */
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

/** A users adapter that implements the full SQL persistence contract. */
export type SqlUsersAdapter = UsersAdapter & {
  hashPassword: NonNullable<UsersAdapter['hashPassword']>
  setPasswordHash: NonNullable<UsersAdapter['setPasswordHash']>
  updateRegistrationData: NonNullable<UsersAdapter['updateRegistrationData']>
  delete: NonNullable<UsersAdapter['delete']>
  /** Report the physical table, id column and email constraint. */
  resolveMetadata(): Promise<UsersAdapterMetadata>
}

/** SQL adapter options for a table whose name comes from Drizzle. */
export type DrizzleAdapterOptions = Omit<SqlUsersAdapterOptions, 'table'>

/** SQL adapter options for a table whose name comes from a Prisma model. */
export type PrismaAdapterOptions = Omit<SqlUsersAdapterOptions, 'table'>

/** The parts of a Prisma DMMF model the adapter reads, as in `Prisma.dmmf.datamodel.models`. */
export interface PrismaModelDefinition {
  name: string
  dbName?: string | null
  fields: ReadonlyArray<{ name: string; dbName?: string | null; kind: string }>
}
