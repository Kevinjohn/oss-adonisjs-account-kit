import { accountKitMigrationSuffix, migrationNames } from './migration_definitions.js'

// Other Account Kit migrations depend on the host users table, but not on one another.
const prerequisites: Record<string, string> = {
  add_scope_to_account_invitations: 'create_account_invitations',
  create_social_handoff_codes: 'create_social_identities',
}

/** Plan before writing anything: existing files are immutable, including their timestamps. */
export function orderedMigrations(files: string[], now: number) {
  const timestamped = files.filter((file) => /^[0-9]+_.*\.[cm]?[jt]s$/.test(file))
  let timestamp = now
  for (const file of timestamped) {
    const prefix = Number(file.split('_')[0])
    timestamp = Math.max(timestamp, prefix + 1)
  }
  const entries = migrationNames.map((name) => {
    const suffix = accountKitMigrationSuffix(name)
    const matches = files.filter((file) => file.endsWith(suffix))
    if (matches.length > 1)
      throw new Error(
        `Multiple existing migrations for ${name}; reconcile their history before setup`
      )
    if (!Number.isSafeInteger(timestamp))
      throw new Error('Migration timestamp exceeds safe integer range')
    return {
      name,
      filename: matches[0] ?? `${timestamp++}${suffix}`,
      existing: matches.length === 1,
    }
  })
  const firstNew = entries.find((entry) => !entry.existing)
  if (firstNew && timestamped.some((file) => file >= firstNew.filename))
    throw new Error(
      'Cannot establish migration order for mixed-width or non-conventional timestamp prefixes; install the remaining Account Kit migrations manually after reviewing existing history'
    )
  for (const entry of entries) {
    const dependency = entries.find(({ name }) => name === prerequisites[entry.name])
    if (
      dependency &&
      entry.existing &&
      (!dependency.existing || dependency.filename >= entry.filename)
    )
      throw new Error(
        `Migration order conflict: ${dependency.name} must run before ${entry.name}; reconcile filenames and applied history manually before setup`
      )
  }
  return entries
}
