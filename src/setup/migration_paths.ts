import { lstat, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { inspectDatabaseConnection } from './database_inspection.js'
import {
  directObject,
  directProperty,
  exportedObject,
  hasUnsafeObjectEntries,
  importedName,
  InvalidSetupSourceError,
  parseSetupSource,
} from './ts_source.js'
import { safeSetupPath } from './safe_path.js'
import { matchesAccountKitMigration, migrationNames } from './migration_definitions.js'

/** The AdonisJS default Lucid migration directory, relative to the application root. */
export const defaultMigrationDirectory = 'database/migrations'

/** Setup cannot choose or read the Lucid migration directory; reported as a setup diagnostic. */
export class MigrationDirectoryError extends Error {
  /** The setup diagnostic field: the directory at fault, or the database config that chose it. */
  readonly field: string

  constructor(message: string, field = 'config/database.ts') {
    super(message)
    this.field = field
  }
}

/** Reports a failure to read or resolve a migration directory against that directory. */
async function withinDirectory<T>(directory: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof MigrationDirectoryError) throw error
    throw new MigrationDirectoryError((error as Error).message, directory)
  }
}

/**
 * Returns the migrations directory set in `adonisrc.ts`, or the AdonisJS default. Throws for a
 * custom config directory, because guided setup writes conventional config files, and for
 * directories it cannot read statically.
 */
export async function guidedMigrationDefault(rc: string): Promise<string> {
  if (!rc) return defaultMigrationDirectory
  let source
  try {
    source = await parseSetupSource(rc)
  } catch (error) {
    if (error instanceof InvalidSetupSourceError) return defaultMigrationDirectory
    throw error
  }
  const config = exportedObject(
    source,
    importedName(source, '@adonisjs/core/app', 'defineConfig') ?? undefined
  )
  // Other setup checks report an unsupported RC shape.
  if (!config) return defaultMigrationDirectory
  if (hasUnsafeObjectEntries(source, config))
    throw new MigrationDirectoryError(
      'Guided setup cannot establish directory settings from an ambiguous adonisrc.ts config; expose its directories statically before setup',
      'adonisrc.ts'
    )
  const directories = directProperty(source, config, 'directories')?.initializer
  if (!directories) return defaultMigrationDirectory
  const object = directObject(source, directories)
  if (!object)
    throw new MigrationDirectoryError(
      'Guided setup requires statically inspectable adonisrc.ts directories',
      'adonisrc.ts'
    )
  const configPath = directProperty(source, object, 'config')?.initializer
  if (configPath && (!source.ts.isStringLiteral(configPath) || configPath.text !== 'config'))
    throw new MigrationDirectoryError(
      'Guided setup requires the conventional config directory; use configure or reconcile setup manually',
      'adonisrc.ts'
    )
  const migrationsPath = directProperty(source, object, 'migrations')?.initializer
  if (!migrationsPath) return defaultMigrationDirectory
  if (!source.ts.isStringLiteral(migrationsPath))
    throw new MigrationDirectoryError(
      'Guided setup requires a literal adonisrc.ts migrations directory',
      'adonisrc.ts'
    )
  return migrationsPath.text
}

/**
 * Chooses the application-relative Lucid migration directory and lists its migration files,
 * reading the database config statically and never executing it. Throws a
 * {@link MigrationDirectoryError} when the directory cannot be chosen or read.
 */
export async function inspectMigrationDirectory(
  root: string,
  config: string,
  explicit?: string,
  env?: NodeJS.ProcessEnv,
  fallbackDirectory = defaultMigrationDirectory,
  required: readonly string[] = migrationNames
) {
  const inspected = await inspectDatabaseConnection(config, root, env)
  let directory: string | undefined = config ? undefined : (explicit ?? fallbackDirectory)
  if (inspected) {
    const { source, connection } = inspected
    const migrations = directProperty(source, connection, 'migrations')?.initializer
    if (!migrations) directory = fallbackDirectory
    else {
      const settings = directObject(source, migrations)
      if (settings && !hasUnsafeObjectEntries(source, settings)) {
        const paths = directProperty(source, settings, 'paths')?.initializer
        if (!paths) directory = fallbackDirectory
        else if (source.ts.isArrayLiteralExpression(paths)) {
          const configured = paths.elements.map((path) =>
            source.ts.isStringLiteral(path) ? path.text : undefined
          )
          if (configured.length > 1)
            directory = await selectConfiguredPath(root, configured, explicit, required)
          else if (!configured.length) directory = fallbackDirectory
          else directory = configured[0]
        }
      }
    }
  }
  if (!directory && !explicit)
    throw new MigrationDirectoryError(
      'Unable to determine the Lucid migration directory statically; pass --migration-directory with the application-relative directory used by the selected connection'
    )
  const normalize = (name: string) => normalizeMigrationDirectory(root, name)
  if (explicit && directory && (await normalize(explicit)) !== (await normalize(directory)))
    throw new MigrationDirectoryError(
      'The explicit migration directory differs from the configured Lucid migration directory'
    )
  const path = await normalize(explicit ?? directory!)
  const names = await readMigrationNames(root, path)
  if (path !== defaultMigrationDirectory) {
    const legacy = await readMigrationNames(root, defaultMigrationDirectory)
    if (
      legacy.some(
        (name) =>
          name.includes('_account_kit_') &&
          !`${defaultMigrationDirectory}/${name}`.startsWith(`${path}/`)
      )
    )
      throw new MigrationDirectoryError(
        'Account Kit migrations already exist in database/migrations; reconcile the migration paths and applied history manually before generating another copy',
        defaultMigrationDirectory
      )
  }
  return { path, names }
}

async function normalizeMigrationDirectory(root: string, name: string) {
  // Lucid resolves these as URLs relative to the app root. Refuse references that
  // could resolve to different paths under URL and filesystem rules.
  if (/[?#%\\:]/.test(name))
    throw new MigrationDirectoryError(
      'Use a plain application-relative Lucid migration directory',
      name
    )
  const path = await withinDirectory(name, () => safeSetupPath(root, name))
  return relative(root, path).split(sep).join('/')
}

/** A configured literal Lucid path and its normalised form, or the reason it is unusable. */
interface ConfiguredPath {
  path: string
  normalized?: string
  problem?: string
}

async function normalizeConfiguredPath(root: string, path: string): Promise<ConfiguredPath> {
  try {
    return { path, normalized: await normalizeMigrationDirectory(root, path) }
  } catch (error) {
    if (!(error instanceof MigrationDirectoryError)) throw error
    return { path, problem: error.message }
  }
}

/**
 * Chooses one of several configured Lucid paths: the one named by `--migration-directory`, or the
 * one that already holds every required migration. A literal path setup cannot use is skipped
 * while choosing. Setup never spreads new migrations across paths, because timestamps cannot
 * order files in different directories.
 */
async function selectConfiguredPath(
  root: string,
  configured: (string | undefined)[],
  explicit: string | undefined,
  required: readonly string[]
): Promise<string | undefined> {
  const literal = configured.filter((path) => path !== undefined)
  const listed = literal.join(', ')
  const paths: ConfiguredPath[] = []
  for (const path of literal) paths.push(await normalizeConfiguredPath(root, path))
  if (explicit) {
    const selected = await normalizeMigrationDirectory(root, explicit)
    const match = paths.find(({ normalized }) => normalized === selected)
    // A dynamic entry may be the named directory; it is used as given, as for one dynamic path.
    if (!match && literal.length === configured.length)
      throw new MigrationDirectoryError(
        `The explicit migration directory is not one of the configured Lucid migration paths: ${listed}`
      )
    await refuseMigrationsInOtherPaths(root, selected, paths, required)
    return match?.path
  }
  for (const { path, normalized } of paths) {
    if (normalized === undefined) continue
    const names = await readMigrationNames(root, normalized)
    if (required.every((name) => names.some((file) => matchesAccountKitMigration(file, name))))
      return path
  }
  throw new MigrationDirectoryError(
    `The Lucid connection lists several migration paths (${listed}) and Account Kit generates into one of them; pass --migration-directory with the configured path to use`
  )
}

/**
 * Lucid runs every configured path, so a required migration that another path already holds and
 * the selected path lacks would be generated twice. A path that cannot be inspected might hold
 * one, so it is refused too unless the selected path already holds every required migration.
 */
async function refuseMigrationsInOtherPaths(
  root: string,
  selected: string,
  paths: ConfiguredPath[],
  required: readonly string[]
) {
  const names = await readMigrationNames(root, selected)
  const missing = required.filter(
    (name) => !names.some((file) => matchesAccountKitMigration(file, name))
  )
  if (!missing.length) return
  for (const { path, normalized, problem } of paths) {
    if (normalized === selected) continue
    let other: string[]
    try {
      if (normalized === undefined) throw new MigrationDirectoryError(problem!, path)
      other = await readMigrationNames(root, normalized)
    } catch (error) {
      if (!(error instanceof MigrationDirectoryError)) throw error
      throw new MigrationDirectoryError(
        `Setup cannot inspect the configured Lucid migration path ${path} (${error.message}), so it cannot rule out Account Kit migrations there that ${selected} lacks; Lucid runs every configured path. Make ${path} inspectable or reconcile the migration paths manually`,
        path
      )
    }
    if (other.some((file) => missing.some((name) => matchesAccountKitMigration(file, name))))
      throw new MigrationDirectoryError(
        `The configured Lucid migration path ${path} already holds Account Kit migrations that ${selected} lacks, and Lucid runs every configured path; select the path that holds them with --migration-directory or reconcile the migration paths manually before generating another copy`,
        path
      )
  }
}

function readMigrationNames(root: string, directory: string): Promise<string[]> {
  return withinDirectory(directory, () => readDirectoryMigrationNames(root, directory))
}

async function readDirectoryMigrationNames(root: string, directory: string): Promise<string[]> {
  const path = await safeSetupPath(root, directory)
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (!stat) return []
  if (!stat.isDirectory()) throw new Error(`Setup refuses non-directory or symlink ${path}`)
  // Lucid walks regular script files recursively and skips hidden entries and symlinks.
  const files = await readdir(path, { recursive: true, withFileTypes: true })
  return files
    .filter(
      (entry) =>
        entry.isFile() && /\.(?:[cm]?js|json|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')
    )
    .map((entry) => relative(path, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((name) => !name.split('/').some((segment) => segment.startsWith('.')))
}
