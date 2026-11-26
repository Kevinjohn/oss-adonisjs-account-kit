import type { PrismaModelDefinition, PrismaAdapterOptions } from '../types_sql_adapters.ts'
import type { SqlUsersAdapter } from './sql.ts'
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from '../errors.ts'
import { createDeferredSqlUsersAdapter } from '../deferred_sql_adapter.ts'
import { canonicalUserColumns } from '../user_columns.ts'

export type { SqlUsersAdapter, SqlUsersAdapterOptions } from './sql.ts'

/** Resolve `@@map` and `@map` and check the user columns. */
function requirePrismaUsersTable(model: PrismaModelDefinition): string {
  if (!model || typeof model.name !== 'string' || !Array.isArray(model.fields))
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'model',
      'account_kit: createPrismaAdapter expects a Prisma DMMF model'
    )
  for (const [property, column] of canonicalUserColumns) {
    const field = model.fields.find((candidate) => candidate.name === property)
    if (!field || field.kind !== 'scalar' || (field.dbName ?? field.name) !== column)
      throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
        `model.fields.${property}`,
        `account_kit: the Prisma ${model.name} model must map the ${property} field to the ${column} column`
      )
  }
  return model.dbName ?? model.name
}

/**
 * A users adapter for a users table defined with Prisma. It reads the model definition only;
 * every query runs through the package's Lucid transaction, so Prisma runtime defaults such as
 * `@default(cuid())` and `@updatedAt` do not run.
 *
 * @example
 * ```ts
 * import { createPrismaAdapter } from '@kevinjohn/adonisjs-account-kit/adapters/prisma'
 * import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
 * import { Prisma } from '@prisma/client'
 *
 * const userModel = Prisma.dmmf.datamodel.models.find((model) => model.name === 'User')
 * if (!userModel) throw new InvalidArgumentsException('Missing User model')
 * const users = createPrismaAdapter(userModel)
 * ```
 */
export function createPrismaAdapter(
  model: PrismaModelDefinition,
  options: PrismaAdapterOptions = {}
): SqlUsersAdapter {
  return createDeferredSqlUsersAdapter(() => requirePrismaUsersTable(model), options)
}

export type { PrismaModelDefinition, PrismaAdapterOptions } from '../types_sql_adapters.ts'
