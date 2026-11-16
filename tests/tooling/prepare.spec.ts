import { test } from '@japa/runner'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

  test('rebuilds a partial build and skips only after both build steps complete', ({ cleanup }) => {
    const root = mkdtempSync(join(tmpdir(), 'prepare-'))
    cleanup(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'bin'))
    mkdirSync(join(root, 'build'))
    mkdirSync(join(root, 'bin-tools'))
    copyFileSync(script, join(root, 'bin', 'prepare.ts'))
    writeFileSync(join(root, 'build', 'index.js'), '')

    const calls = join(root, 'calls')
    const pnpm = join(root, 'bin-tools', 'pnpm')
    writeFileSync(pnpm, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PREPARE_CALLS"\n')
    chmodSync(pnpm, 0o755)

    const runPrepare = () =>
      spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('@poppinss/ts-exec'), join(root, 'bin', 'prepare.ts')],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: join(root, 'bin-tools'), PREPARE_CALLS: calls },
        }
      )

    const firstRun = runPrepare()
    assert.equal(firstRun.status, 0, firstRun.stderr)
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [
      '--config.enable-pre-post-scripts=false run compile',
      '--config.enable-pre-post-scripts=false run copy:templates',
    ])
    assert.equal(existsSync(join(root, 'build', '.prepare-complete')), true)

    const secondRun = runPrepare()
    assert.equal(secondRun.status, 0, secondRun.stderr)
    assert.match(secondRun.stderr, /build\/ present, nothing to compile/)
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 2)
  })
})
