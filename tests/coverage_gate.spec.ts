import { readFile } from 'node:fs/promises'
import { test } from '@japa/runner'

test('enforces coverage thresholds only through pnpm test', async ({ assert }) => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

  // The docs workflow runs c8 for the coverage badge. Thresholds in the shared c8 config would
  // also gate that run, so a coverage dip would stop the docs from publishing.
  assert.notProperty(manifest.c8, 'check-coverage')
  assert.equal(
    manifest.scripts.test,
    'c8 --check-coverage --lines 94 --branches 90 --functions 94 pnpm quick:test'
  )
})
