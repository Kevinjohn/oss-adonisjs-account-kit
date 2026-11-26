// Builds a SQL users adapter on first use, so schema validation errors surface when the adapter
// is first called rather than when the config file is imported.
import {
  createSqlUsersAdapter,
  type SqlUsersAdapter,
  type SqlUsersAdapterOptions,
} from './adapters/sql.ts'

export function createDeferredSqlUsersAdapter(
  resolveTable: () => string,
  options: Omit<SqlUsersAdapterOptions, 'table'>
): SqlUsersAdapter {
  return new DeferredSqlUsersAdapter(resolveTable, options)
}

class DeferredSqlUsersAdapter implements SqlUsersAdapter {
  #adapter: SqlUsersAdapter | undefined
  #resolveTable: () => string
  #options: Omit<SqlUsersAdapterOptions, 'table'>

  constructor(resolveTable: () => string, options: Omit<SqlUsersAdapterOptions, 'table'>) {
    this.#resolveTable = resolveTable
    this.#options = options
  }

  #resolveInnerAdapter(): SqlUsersAdapter {
    const resolveTable = this.#resolveTable
    return (this.#adapter ??= createSqlUsersAdapter({ ...this.#options, table: resolveTable() }))
  }

  resolveMetadata: SqlUsersAdapter['resolveMetadata'] = async () =>
    this.#resolveInnerAdapter().resolveMetadata()
  findByEmail: SqlUsersAdapter['findByEmail'] = async (...args) =>
    this.#resolveInnerAdapter().findByEmail(...args)
  findById: SqlUsersAdapter['findById'] = async (...args) =>
    this.#resolveInnerAdapter().findById(...args)
  create: SqlUsersAdapter['create'] = async (...args) => this.#resolveInnerAdapter().create(...args)
  setPassword: SqlUsersAdapter['setPassword'] = async (...args) =>
    this.#resolveInnerAdapter().setPassword(...args)
  hashPassword: SqlUsersAdapter['hashPassword'] = async (...args) =>
    this.#resolveInnerAdapter().hashPassword(...args)
  setPasswordHash: SqlUsersAdapter['setPasswordHash'] = async (...args) =>
    this.#resolveInnerAdapter().setPasswordHash(...args)
  setEmail: SqlUsersAdapter['setEmail'] = async (...args) =>
    this.#resolveInnerAdapter().setEmail(...args)
  setUnverifiedEmail: SqlUsersAdapter['setUnverifiedEmail'] = async (...args) =>
    this.#resolveInnerAdapter().setUnverifiedEmail(...args)
  updateRegistrationData: SqlUsersAdapter['updateRegistrationData'] = async (...args) =>
    this.#resolveInnerAdapter().updateRegistrationData(...args)
  markEmailVerified: SqlUsersAdapter['markEmailVerified'] = async (...args) =>
    this.#resolveInnerAdapter().markEmailVerified(...args)
  verifyPassword: SqlUsersAdapter['verifyPassword'] = async (...args) =>
    this.#resolveInnerAdapter().verifyPassword(...args)
  delete: SqlUsersAdapter['delete'] = async (...args) => this.#resolveInnerAdapter().delete(...args)
}
