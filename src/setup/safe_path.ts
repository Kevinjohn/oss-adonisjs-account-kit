import { lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Refuse any link between the application root and a path read or written by setup. */
export async function safeSetupPath(root: string, name: string): Promise<string> {
  const path = resolve(root, name)
  const fromRoot = relative(root, path)
  if (
    !name ||
    isAbsolute(name) ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    path === root
  )
    throw new Error(`Setup path escapes the application: ${name}`)
  let parent = dirname(path)
  while (parent !== root) {
    try {
      const entry = await lstat(parent)
      if (!entry.isDirectory()) throw new Error(`Setup refuses non-directory or symlink ${parent}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    parent = dirname(parent)
  }
  return path
}

/** Read a regular file inside the application root; `null` when it does not exist. */
export async function readRegularFile(root: string, name: string): Promise<string | null> {
  const path = await safeSetupPath(root, name)
  try {
    const entry = await lstat(path)
    if (!entry.isFile()) throw new Error(`Setup refuses non-regular file ${name}`)
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
