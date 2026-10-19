// SQL identifier shape check shared by config and database metadata validation.
const sqlIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isSqlIdentifier(value: string): boolean {
  return sqlIdentifier.test(value)
}
