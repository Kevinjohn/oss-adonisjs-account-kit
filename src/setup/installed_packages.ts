import { readFile, lstat, realpath } from 'node:fs/promises'
import { join, relative as pathRelative, sep } from 'node:path'
import { safeSetupPath } from './safe_path.js'

export async function installedPackageVersions(
  root: string,
  declaredPackages: string[]
): Promise<Record<string, string>> {
  const installedVersions: Record<string, string> = {}
  for (const name of declaredPackages) {
    if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) continue
    try {
      await safeSetupPath(root, `node_modules/${name}`)
      const directory = await realpath(join(root, 'node_modules', name))
      const fromRoot = pathRelative(root, directory)
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) continue
      const metadata = await safeSetupPath(root, join(fromRoot, 'package.json'))
      const metadataStat = await lstat(metadata)
      if (!metadataStat.isFile())
        throw new Error(`Setup cannot inspect non-regular file ${metadata}`)
      const installed = JSON.parse(await readFile(metadata, 'utf8')) as {
        version?: string
      }
      if (typeof installed.version === 'string') installedVersions[name] = installed.version
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return installedVersions
}
