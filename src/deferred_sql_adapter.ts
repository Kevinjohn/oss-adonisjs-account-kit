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
  let adapter: SqlUsersAdapter | undefined
  const resolveInnerAdapter = () =>
    (adapter ??= createSqlUsersAdapter({ ...options, table: resolveTable() }))
  return {
    resolveMetadata: async () => resolveInnerAdapter().resolveMetadata(),
    findByEmail: async (...args) => resolveInnerAdapter().findByEmail(...args),
    findById: async (...args) => resolveInnerAdapter().findById(...args),
    create: async (...args) => resolveInnerAdapter().create(...args),
    setPassword: async (...args) => resolveInnerAdapter().setPassword(...args),
    hashPassword: async (...args) => resolveInnerAdapter().hashPassword(...args),
    setPasswordHash: async (...args) => resolveInnerAdapter().setPasswordHash(...args),
    setEmail: async (...args) => resolveInnerAdapter().setEmail(...args),
    setUnverifiedEmail: async (...args) => resolveInnerAdapter().setUnverifiedEmail(...args),
    updateRegistrationData: async (...args) =>
      resolveInnerAdapter().updateRegistrationData(...args),
    markEmailVerified: async (...args) => resolveInnerAdapter().markEmailVerified(...args),
    verifyPassword: async (...args) => resolveInnerAdapter().verifyPassword(...args),
    delete: async (...args) => resolveInnerAdapter().delete(...args),
  }
}
