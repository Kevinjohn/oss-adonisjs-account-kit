import { posix } from 'node:path'
import {
  accountKitMigrationSuffix,
  matchesAccountKitMigration,
  migrationNames,
} from './migration_definitions.js'

// Other Account Kit migrations depend on the host users table, but not on one another.
const prerequisites: Record<string, string> = {
  add_scope_to_account_invitations: 'create_account_invitations',
  create_social_handoff_codes: 'create_social_identities',
}

function runsBefore(first: string, second: string) {
  // Lucid compares relative paths, optionally with natural sort. Require both orders to agree.
  return (
    first < second &&
    first.localeCompare(second, undefined, { numeric: true, sensitivity: 'base' }) < 0
  )
}

/** Plan before writing anything: existing files are immutable, including their relative paths. */
export function orderedMigrations(files: string[], now: number, operations = migrationNames) {
  const timestamped = files.filter((file) => /^[0-9]+_/.test(posix.basename(file))).sort()
  const last = timestamped.at(-1)
  const directory = last ? posix.dirname(last) : '.'
  let timestamp = now
  for (const file of timestamped) {
    const prefix = Number(posix.basename(file).split('_')[0])
    timestamp = Math.max(timestamp, prefix + 1)
  }
  const entries = operations.map((name) => {
    const matches = files.filter((file) => matchesAccountKitMigration(file, name))
    if (matches.length > 1)
      throw new Error(
        `Multiple existing migrations for ${name}; reconcile their history before setup`
      )
    if (matches.length === 1) return { name, filename: matches[0], existing: true }
    if (!Number.isSafeInteger(timestamp))
      throw new Error('Migration timestamp exceeds safe integer range')
    return {
      name,
      filename: posix.join(directory, `${timestamp++}${accountKitMigrationSuffix(name)}`),
      existing: false,
    }
  })
  const firstNew = entries.find((entry) => !entry.existing)
  if (firstNew && timestamped.some((file) => !runsBefore(file, firstNew.filename)))
    throw new Error(
      'Cannot establish migration order for mixed-width or non-conventional timestamp prefixes; install the remaining Account Kit migrations manually after reviewing existing history'
    )
  for (const entry of entries) {
    const dependency = entries.find(({ name }) => name === prerequisites[entry.name])
    if (
      dependency &&
      ((entry.existing && !dependency.existing) || !runsBefore(dependency.filename, entry.filename))
    )
      throw new Error(
        `Migration order conflict: ${dependency.name} must run before ${entry.name}; reconcile filenames and applied history manually before setup`
      )
  }
  return entries
}
