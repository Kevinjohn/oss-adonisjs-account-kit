import type { SqlUsersAdapter, SqlUsersAdapterOptions } from './sql.js'
import { deferredSqlUsersAdapter } from '../src/deferred_sql_adapter.js'
import { canonicalUserColumns } from '../src/user_columns.js'

export type { SqlUsersAdapter, SqlUsersAdapterOptions } from './sql.js'

export type PrismaAdapterOptions = Omit<SqlUsersAdapterOptions, 'table'>

/** The parts of a Prisma DMMF model the adapter reads, as in `Prisma.dmmf.datamodel.models`. */
export interface PrismaModelDefinition {
  name: string
  dbName?: string | null
  fields: ReadonlyArray<{ name: string; dbName?: string | null; kind: string }>
}

/** Resolve `@@map` and `@map` and check the user columns. */
function prismaUsersTable(model: PrismaModelDefinition): string {
  if (!model || typeof model.name !== 'string' || !Array.isArray(model.fields))
    throw new Error('account_kit: createPrismaAdapter expects a Prisma DMMF model')
  for (const [property, column] of canonicalUserColumns) {
    const field = model.fields.find((candidate) => candidate.name === property)
    if (!field || field.kind !== 'scalar' || (field.dbName ?? field.name) !== column)
      throw new Error(
        `account_kit: the Prisma ${model.name} model must map the ${property} field to the ${column} column`
      )
  }
  return model.dbName ?? model.name
}

/**
 * A users adapter for a users table defined with Prisma. It reads the model definition only;
 * every query runs through the package's Lucid transaction, so Prisma runtime defaults such as
 * `@default(cuid())` and `@updatedAt` do not run.
 */
export function createPrismaAdapter(
  model: PrismaModelDefinition,
  options: PrismaAdapterOptions = {}
): SqlUsersAdapter {
  return deferredSqlUsersAdapter(() => prismaUsersTable(model), options)
}
