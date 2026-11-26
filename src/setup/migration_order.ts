import { RuntimeException } from '@adonisjs/core/exceptions'
import { posix } from 'node:path'
import {
  formatMigrationSuffix,
  matchesAccountKitMigration,
  migrationNames,
} from './migration_definitions.ts'

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

/**
 * Lists each named migration with its existing file or a new timestamped filename after the
 * existing ones, without writing anything. Existing files keep their relative paths. Throws when
 * the order cannot be established.
 */
export function orderMigrations(files: string[], now: number, names = migrationNames) {
  const hasTimestamp = (file: string) => /^[0-9]+_/.test(posix.basename(file))
  const timestamped = files.filter(hasTimestamp).sort()
  const last = timestamped.at(-1)
  const directory = last ? posix.dirname(last) : '.'
  let timestamp = now
  for (const file of timestamped) {
    const prefix = Number(posix.basename(file).split('_')[0])
    timestamp = Math.max(timestamp, prefix + 1)
  }
  const entries = names.map((name) => {
    const matches = files.filter((file) => matchesAccountKitMigration(file, name))
    if (matches.length > 1)
      throw new RuntimeException(
        `Multiple existing migrations for ${name}; reconcile their history before setup`
      )
    if (matches.length === 1) return { name, filename: matches[0], existing: true }
    if (!Number.isSafeInteger(timestamp))
      throw new RuntimeException('Migration timestamp exceeds safe integer range')
    return {
      name,
      filename: posix.join(directory, `${timestamp++}${formatMigrationSuffix(name)}`),
      existing: false,
    }
  })
  // Host migrations can supply prerequisite tables even without a timestamp. Known Account Kit
  // files with custom names only impose ordering through the dependencies below.
  const managedNames = [...migrationNames, ...names]
  const prior = files.filter(
    (file) =>
      hasTimestamp(file) || !managedNames.some((name) => matchesAccountKitMigration(file, name))
  )
  if (
    entries.some(
      (entry) => !entry.existing && prior.some((file) => !runsBefore(file, entry.filename))
    )
  )
    throw new RuntimeException(
      'Cannot establish migration order for mixed-width or non-conventional migration filenames; install the remaining Account Kit migrations manually after reviewing existing history'
    )
  for (const entry of entries) {
    const dependency = entries.find(({ name }) => name === prerequisites[entry.name])
    if (
      dependency &&
      ((entry.existing && !dependency.existing) || !runsBefore(dependency.filename, entry.filename))
    )
      throw new RuntimeException(
        `Migration order conflict: ${dependency.name} must run before ${entry.name}; reconcile filenames and applied history manually before setup`
      )
  }
  return entries
}
