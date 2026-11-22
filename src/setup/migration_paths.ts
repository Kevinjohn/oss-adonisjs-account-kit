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

export const defaultMigrationDirectory = 'database/migrations'

export class MigrationDirectoryError extends Error {}

/** Guided setup writes conventional config files; refuse a custom config directory rather than
 * silently inspecting or modifying the wrong files. It can inspect a literal migrations override. */
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
  if (!config) return defaultMigrationDirectory // other setup checks report an unsupported RC shape
  if (hasUnsafeObjectEntries(source, config))
    throw new MigrationDirectoryError(
      'Guided setup cannot establish directory settings from an ambiguous adonisrc.ts config; expose its directories statically before setup'
    )
  const directories = directProperty(source, config, 'directories')?.initializer
  if (!directories) return defaultMigrationDirectory
  const object = directObject(source, directories)
  if (!object)
    throw new MigrationDirectoryError(
      'Guided setup requires statically inspectable adonisrc.ts directories'
    )
  const configPath = directProperty(source, object, 'config')?.initializer
  if (configPath && (!source.ts.isStringLiteral(configPath) || configPath.text !== 'config'))
    throw new MigrationDirectoryError(
      'Guided setup requires the conventional config directory; use configure or reconcile setup manually'
    )
  const migrationsPath = directProperty(source, object, 'migrations')?.initializer
  if (!migrationsPath) return defaultMigrationDirectory
  if (!source.ts.isStringLiteral(migrationsPath))
    throw new MigrationDirectoryError(
      'Guided setup requires a literal adonisrc.ts migrations directory'
    )
  return migrationsPath.text
}

/** Never execute the application database config when choosing a destination. */
export async function inspectMigrationDirectory(
  root: string,
  config: string,
  explicit?: string,
  env?: NodeJS.ProcessEnv,
  fallbackDirectory = defaultMigrationDirectory
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
          if (paths.elements.length > 1)
            throw new MigrationDirectoryError(
              'Account Kit needs one migration directory; review ordering across configured Lucid migration paths and install migrations manually'
            )
          const path = paths.elements[0]
          if (!path) directory = fallbackDirectory
          else if (source.ts.isStringLiteral(path)) directory = path.text
        }
      }
    }
  }
  if (!directory && !explicit)
    throw new MigrationDirectoryError(
      'Unable to determine the Lucid migration directory statically; pass --migration-directory with the application-relative directory used by the selected connection'
    )
  const normalize = async (name: string) => {
    // Lucid resolves these as URLs relative to the app root. Refuse references that
    // could resolve to different paths under URL and filesystem rules.
    if (/[?#%\\:]/.test(name))
      throw new MigrationDirectoryError(
        'Use a plain application-relative Lucid migration directory'
      )
    return relative(root, await safeSetupPath(root, name))
      .split(sep)
      .join('/')
  }
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
        'Account Kit migrations already exist in database/migrations; reconcile the migration paths and applied history manually before generating another copy'
      )
  }
  return { path, names }
}

async function readMigrationNames(root: string, directory: string): Promise<string[]> {
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
