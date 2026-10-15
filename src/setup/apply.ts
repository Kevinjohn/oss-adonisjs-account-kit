import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { SetupFileChange, SetupPlan } from './types.js'

async function currentFile(path: string): Promise<string | null> {
  try {
    const fileStat = await lstat(path)
    if (!fileStat.isFile()) throw new Error(`Setup refuses non-regular file ${path}`)
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function assertSafePath(root: string, name: string): Promise<string> {
  const path = resolve(root, name)
  const fromRoot = relative(root, path)
  if (
    !name ||
    name.startsWith('/') ||
    fromRoot === '..' ||
    fromRoot.startsWith('..' + sep) ||
    path === root
  )
    throw new Error(`Setup path escapes the application: ${name}`)
  let parent = dirname(path)
  while (parent !== root) {
    try {
      const parentStat = await lstat(parent)
      if (!parentStat.isDirectory())
        throw new Error(`Setup refuses non-directory or symlink ${parent}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    parent = dirname(parent)
  }
  return path
}

async function assertNoConflict(
  root: string,
  change: SetupFileChange
): Promise<'create' | 'update' | 'unchanged'> {
  const path = await assertSafePath(root, change.path)
  const existing = await currentFile(path)
  if (existing === null) {
    if (change.action === 'update')
      throw new Error(`Setup conflict at ${change.path}: application file disappeared`)
    return 'create'
  }
  if (existing === change.content) return 'unchanged'
  if (change.action === 'update' && existing === change.expected) return 'update'
  throw new Error(
    `Setup conflict at ${change.path}: existing file differs; resolve manually before retry`
  )
}

/** Preflight all files, then check again immediately before each exclusive create. */
export async function applySetup(root: string, plan: SetupPlan): Promise<string[]> {
  root = await realpath(root)
  if (plan.preview) throw new Error('Setup is in preview mode; pass --apply to write files')
  const blocking = plan.diagnostics.filter((item) => item.severity === 'error')
  if (blocking.length)
    throw new Error(
      `Setup has blocking diagnostics: ${blocking.map((item) => item.field).join(', ')}`
    )
  for (const change of plan.changes) await assertNoConflict(root, change)
  const written: string[] = []
  for (const change of plan.changes) {
    const path = join(root, change.path)
    const action = await assertNoConflict(root, change)
    if (action === 'unchanged') continue
    await mkdir(dirname(path), { recursive: true })
    await assertSafePath(root, change.path)
    if (action === 'create') {
      await writeFile(path, change.content, { flag: 'wx', mode: 0o644 })
    } else {
      const temp = `${path}.account-kit-${process.pid}-${randomUUID()}.tmp`
      const fileStat = await stat(path)
      const mode = fileStat.mode
      try {
        await writeFile(temp, change.content, { flag: 'wx', mode })
        await assertNoConflict(root, change)
        await rename(temp, path)
      } finally {
        await rm(temp, { force: true })
      }
    }
    written.push(change.path)
  }
  return written
}
