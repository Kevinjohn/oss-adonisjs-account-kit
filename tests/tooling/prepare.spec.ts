import { test } from '@japa/runner'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../bin/prepare.ts', import.meta.url))

test.group('prepare', () => {
  test('says why when pnpm cannot be started', ({ cleanup }) => {
    // A copy whose package root has no build/ and a PATH without pnpm, as in an npm git install.
    const root = mkdtempSync(join(tmpdir(), 'prepare-'))
    cleanup(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'bin'))
    copyFileSync(script, join(root, 'bin', 'prepare.ts'))
    const result = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('@poppinss/ts-exec'), join(root, 'bin', 'prepare.ts')],
      { encoding: 'utf8', env: { ...process.env, PATH: '' } }
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[prepare\] spawnSync pnpm ENOENT/)
  })
})
