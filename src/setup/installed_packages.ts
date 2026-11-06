import { readFile, lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function installedPackageVersions(
  root: string,
  declaredPackages: string[]
): Promise<Record<string, string>> {
  const installedVersions: Record<string, string> = {}
  for (const name of declaredPackages) {
    if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) continue
    const version = await installedVersion(root, name)
    if (version !== null) installedVersions[name] = version
  }
  return installedVersions
}

/**
 * Find the package the way Node resolves it: the nearest `node_modules/<name>` from the application
 * up, following links, so workspace and pnpm store installs count.
 */
async function installedVersion(root: string, name: string): Promise<string | null> {
  for (let directory = root; ; directory = dirname(directory)) {
    try {
      const metadata = join(await realpath(join(directory, 'node_modules', name)), 'package.json')
      const metadataStat = await lstat(metadata)
      if (!metadataStat.isFile())
        throw new Error(`Setup cannot inspect non-regular file ${metadata}`)
      const installed = JSON.parse(await readFile(metadata, 'utf8')) as { version?: string }
      return typeof installed.version === 'string' ? installed.version : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (dirname(directory) === directory) return null
  }
}
