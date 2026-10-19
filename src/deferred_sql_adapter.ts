// Builds a SQL users adapter on first use, so schema validation errors surface when the adapter
// is first called rather than when the config file is imported.
import {
  createSqlUsersAdapter,
  type SqlUsersAdapter,
  type SqlUsersAdapterOptions,
} from '../adapters/sql.js'

export function deferredSqlUsersAdapter(
  resolveTable: () => string,
  options: Omit<SqlUsersAdapterOptions, 'table'>
): SqlUsersAdapter {
  let adapter: SqlUsersAdapter | undefined
  const inner = () => (adapter ??= createSqlUsersAdapter({ ...options, table: resolveTable() }))
  return {
    resolveMetadata: async () => inner().resolveMetadata(),
    findByEmail: async (...args) => inner().findByEmail(...args),
    findById: async (...args) => inner().findById(...args),
    create: async (...args) => inner().create(...args),
    setPassword: async (...args) => inner().setPassword(...args),
    setEmail: async (...args) => inner().setEmail(...args),
    setUnverifiedEmail: async (...args) => inner().setUnverifiedEmail(...args),
    updateRegistrationData: async (...args) => inner().updateRegistrationData(...args),
    markEmailVerified: async (...args) => inner().markEmailVerified(...args),
    verifyPassword: async (...args) => inner().verifyPassword(...args),
    delete: async (...args) => inner().delete(...args),
  }
}
