import { randomUUID } from 'node:crypto'
import { link, mkdir, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SetupFileChange, SetupPlan } from './types.js'
import { readRegularFile, safeSetupPath } from './safe_path.js'

async function assertNoConflict(
  root: string,
  change: SetupFileChange
): Promise<'create' | 'update' | 'unchanged'> {
  const existing = await readRegularFile(root, change.path)
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

/** Apply under a project lock. The caller must keep other editors out of this workspace. */
export async function applySetup(
  root: string,
  plan: SetupPlan,
  options: { beforePublish?: (temporary: string, destination: string) => Promise<void> } = {}
): Promise<string[]> {
  root = await realpath(root)
  if (plan.preview) throw new Error('Setup is in preview mode; pass --apply to write files')
  const blocking = plan.diagnostics.filter((item) => item.severity === 'error')
  if (blocking.length)
    throw new Error(
      `Setup has blocking diagnostics: ${blocking.map((item) => item.field).join(', ')}`
    )
  for (const change of plan.changes) await assertNoConflict(root, change)
  const lockPath = join(root, '.account-kit-setup.lock')
  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `Setup is already applying or was interrupted; inspect and remove ${lockPath} before retrying`
      )
    throw error
  }
  const written: string[] = []
  try {
    await lock.writeFile(`${process.pid} ${new Date().toISOString()}\n`)
    for (const change of plan.changes) await assertNoConflict(root, change)
    for (const change of plan.changes) {
      const path = await safeSetupPath(root, change.path)
      const action = await assertNoConflict(root, change)
      if (action === 'unchanged') continue
      await mkdir(dirname(path), { recursive: true })
      await safeSetupPath(root, change.path)
      const temp = `${path}.account-kit-${process.pid}-${randomUUID()}.tmp`
      try {
        const oldStat = action === 'update' ? await stat(path) : null
        const mode = oldStat?.mode ?? 0o644
        await writeFile(temp, change.content, { flag: 'wx', mode })
        await assertNoConflict(root, change)
        await options.beforePublish?.(temp, path)
        if (action === 'create') await link(temp, path)
        else await rename(temp, path)
      } finally {
        await rm(temp, { force: true })
      }
      written.push(change.path)
    }
  } finally {
    await lock.close()
    await rm(lockPath, { force: true })
  }
  return written
}
