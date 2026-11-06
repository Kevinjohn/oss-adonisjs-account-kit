import { test } from '@japa/runner'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../bin/copy_templates.ts', import.meta.url))
const run = (directory: string) =>
  spawnSync(process.execPath, ['--import', import.meta.resolve('@poppinss/ts-exec'), script], {
    cwd: directory,
    encoding: 'utf8',
  })

test.group('copy templates', () => {
  test('copies only stub files with their nested paths and exact contents', ({ cleanup }) => {
    const directory = mkdtempSync(join(tmpdir(), 'template-copy-'))
    cleanup(() => rmSync(directory, { recursive: true, force: true }))
    mkdirSync(join(directory, 'stubs', 'config', 'nested'), { recursive: true })
    const bytes = Buffer.from('template\r\nwith unicode: ñ\n')
    writeFileSync(join(directory, 'stubs', 'config', 'nested', 'example.stub'), bytes)
    writeFileSync(join(directory, 'stubs', 'main.ts'), 'export {}')
    const result = run(directory)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(
      readFileSync(join(directory, 'build', 'config', 'nested', 'example.stub')),
      bytes
    )
    assert.equal(existsSync(join(directory, 'build', 'main.ts')), false)
    assert.equal(existsSync(join(directory, 'build', 'stubs', 'main.ts')), false)
  })

  test('fails when a destination parent cannot be created', ({ cleanup }) => {
    const directory = mkdtempSync(join(tmpdir(), 'template-copy-error-'))
    cleanup(() => rmSync(directory, { recursive: true, force: true }))
    mkdirSync(join(directory, 'stubs', 'config'), { recursive: true })
    writeFileSync(join(directory, 'stubs', 'config', 'example.stub'), 'template')
    writeFileSync(join(directory, 'build'), 'not a directory')
    const result = run(directory)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /EEXIST|ENOTDIR/)
  })
})
