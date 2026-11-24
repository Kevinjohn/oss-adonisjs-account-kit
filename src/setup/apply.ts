import { RuntimeException } from '@adonisjs/core/exceptions'
import { randomUUID } from 'node:crypto'
import { link, mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import fsPromises from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SetupFileChange, SetupPlan } from './types.js'
import {
  E_ACCOUNT_KIT_SETUP_APPLY_INTERRUPTED,
  E_ACCOUNT_KIT_SETUP_CLEANUP_FAILED,
} from '../errors.js'
import { readRegularFile, requireSafeSetupPath } from './safe_path.js'

function formatFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function assertNoConflict(
  root: string,
  change: SetupFileChange
): Promise<'create' | 'update' | 'unchanged'> {
  const existing = await readRegularFile(root, change.path)
  if (existing === null) {
    if (change.action === 'update')
      throw new RuntimeException(`Setup conflict at ${change.path}: application file disappeared`)
    return 'create'
  }
  if (existing === change.content) return 'unchanged'
  if (change.action === 'update' && existing === change.expected) return 'update'
  throw new RuntimeException(
    `Setup conflict at ${change.path}: existing file differs; resolve manually before retry`
  )
}

/**
 * Apply under a project lock. The caller must keep other editors out of this workspace.
 *
 * @throws {AggregateError} Write and cleanup both failed, with the write failure first.
 * @throws {E_ACCOUNT_KIT_SETUP_APPLY_INTERRUPTED} Applying setup failed after publishing files.
 * Its cause can be an AggregateError when writing and cleanup both failed.
 */
export async function applySetup(
  root: string,
  plan: SetupPlan,
  options: { beforePublish?: (temporary: string, destination: string) => Promise<void> } = {}
): Promise<string[]> {
  root = await realpath(root)
  if (plan.preview)
    throw new RuntimeException('Setup is in preview mode; pass --apply to write files')
  const blocking = plan.diagnostics.filter((item) => item.severity === 'error')
  if (blocking.length)
    throw new RuntimeException(
      `Setup has blocking diagnostics: ${blocking.map((item) => item.field).join(', ')}`
    )
  for (const change of plan.changes) await assertNoConflict(root, change)
  const lockPath = join(root, '.account-kit-setup.lock')
  let lock
  try {
    lock = await fsPromises.open(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new RuntimeException(
        `Setup is already applying or was interrupted; inspect and remove ${lockPath} before retrying`
      )
    throw error
  }
  const written: string[] = []
  let primary: { error: unknown } | undefined
  const cleanup: unknown[] = []
  try {
    await lock.writeFile(`${process.pid} ${new Date().toISOString()}\n`)
    for (const change of plan.changes) await assertNoConflict(root, change)
    for (const change of plan.changes) {
      const path = await requireSafeSetupPath(root, change.path)
      const action = await assertNoConflict(root, change)
      if (action === 'unchanged') continue
      await mkdir(dirname(path), { recursive: true })
      await requireSafeSetupPath(root, change.path)
      const temp = `${path}.account-kit-${process.pid}-${randomUUID()}.tmp`
      try {
        const oldStat = action === 'update' ? await stat(path) : null
        const mode = oldStat?.mode ?? 0o644
        await writeFile(temp, change.content, { flag: 'wx', mode })
        await assertNoConflict(root, change)
        await options.beforePublish?.(temp, path)
        if (action === 'create') await link(temp, path)
        else await rename(temp, path)
        written.push(change.path)
      } catch (error) {
        primary = { error }
      }
      try {
        await fsPromises.rm(temp, { force: true })
      } catch (error) {
        cleanup.push(error)
      }
      if (primary || cleanup.length) break
    }
  } catch (error) {
    primary = { error }
  }

  try {
    await lock.close()
  } catch (error) {
    cleanup.push(error)
  }
  try {
    await fsPromises.rm(lockPath, { force: true })
  } catch (error) {
    cleanup.push(error)
  }

  if (primary || cleanup.length) {
    const failure = primary
      ? cleanup.length
        ? new AggregateError(
            [primary.error, ...cleanup],
            `Setup and cleanup failed: ${[primary.error, ...cleanup].map(formatFailureMessage).join('; ')}`,
            { cause: primary.error }
          )
        : primary.error
      : cleanup.length === 1
        ? cleanup[0]
        : new E_ACCOUNT_KIT_SETUP_CLEANUP_FAILED(cleanup)
    if (written.length) throw new E_ACCOUNT_KIT_SETUP_APPLY_INTERRUPTED(written, { cause: failure })
    throw failure
  }
  return written
}
