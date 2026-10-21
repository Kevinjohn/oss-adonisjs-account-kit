import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

const examplesRoot = fileURLToPath(new URL('../examples', import.meta.url))

test('examples that pack the local archive can run kit:pack before their first install', async ({
  assert,
}) => {
  const packing: string[] = []
  for (const entry of await readdir(examplesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = await readFile(join(examplesRoot, entry.name, 'package.json'), 'utf8').catch(
      () => undefined
    )
    if (manifest && JSON.parse(manifest).scripts?.['kit:pack']) packing.push(entry.name)
  }
  assert.isAbove(packing.length, 0)

  // pnpm otherwise installs before the script runs, and the archive does not exist yet.
  const blocked = []
  for (const name of packing) {
    const workspace = await readFile(join(examplesRoot, name, 'pnpm-workspace.yaml'), 'utf8')
    if (!/^verifyDepsBeforeRun: false$/m.test(workspace)) blocked.push(name)
  }
  assert.deepEqual(blocked, [])
})

test('examples that pack the local archive do not install it with a frozen lockfile', async ({
  assert,
}) => {
  const frozen: string[] = []
  for (const entry of await readdir(examplesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = join(examplesRoot, entry.name)
    const manifest = await readFile(join(directory, 'package.json'), 'utf8').catch(() => undefined)
    if (!manifest || !JSON.parse(manifest).scripts?.['kit:pack']) continue
    const readme = await readFile(join(directory, 'README.md'), 'utf8')
    // The root install is frozen; the archive's integrity changes with every local build.
    for (const line of readme.split('\n'))
      if (
        /^pnpm\b.*\binstall\b.*--frozen-lockfile/.test(line.trim()) &&
        line.trim() !== 'pnpm install --frozen-lockfile'
      )
        frozen.push(`${entry.name}: ${line.trim()}`)
  }
  assert.deepEqual(frozen, [])
})
