import { test } from '@japa/runner'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const renderer = fileURLToPath(new URL('../../bin/demos/render.ts', import.meta.url))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'demo-render-'))
  const casts = join(root, 'casts')
  const bin = join(root, 'bin')
  mkdirSync(casts)
  mkdirSync(bin)
  writeFileSync(
    join(casts, 'sample.cast'),
    [
      { version: 2, width: 100, height: 24 },
      [0.1, 'o', 'Starting\r\n'],
      [1.2345, 'o', '\u001b[32mCompleted successfully\u001b[0m\r\n'],
      [2, 'i', 'ignored input'],
      [3, 'o', '\u001b[0m\r\n'],
      [4, 'o', ''],
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n'
  )
  writeFileSync(
    join(bin, 'pnpm'),
    `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.TRACE, JSON.stringify(args) + '\\n')
if (process.env.FAIL_RENDER === '1' && args.includes('--at')) process.exit(7)
fs.writeFileSync(args[args.indexOf('--out') + 1], 'rendered')
`,
    { mode: 0o755 }
  )
  const output = join(root, 'svg')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRACE: join(root, 'trace') }
  return { root, casts, output, env }
}

test('demo renderer pairs unchanged animation names with representative cursor-free stills', () => {
  const f = fixture()
  try {
    execFileSync(process.execPath, ['--import=@poppinss/ts-exec', renderer, f.casts, f.output], {
      env: f.env,
    })
    const calls: string[][] = readFileSync(f.env.TRACE, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(calls.length, 2)
    for (const args of calls) {
      assert.deepEqual(args.slice(0, 2), ['dlx', 'svg-term-cli@2.1.1'])
      assert.deepEqual(args.slice(2, 11), [
        '--in',
        join(f.casts, 'sample.cast'),
        '--window',
        '--width',
        '100',
        '--height',
        '24',
        '--padding',
        '12',
      ])
    }
    assert.deepEqual(calls[0].slice(11), ['--out', join(f.output, 'sample.svg')])
    assert.deepEqual(calls[1].slice(11), [
      '--out',
      join(f.output, 'sample_still.svg'),
      '--at',
      '1235',
      '--no-cursor',
    ])
    assert.equal(readFileSync(join(f.output, 'sample_still.svg'), 'utf8'), 'rendered')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('demo renderer propagates still rendering failure', () => {
  const f = fixture()
  try {
    const result = spawnSync(
      process.execPath,
      ['--import=@poppinss/ts-exec', renderer, f.casts, f.output],
      { env: { ...f.env, FAIL_RENDER: '1' }, encoding: 'utf8' }
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Command failed: pnpm/)
    assert.equal(readFileSync(f.env.TRACE, 'utf8').trim().split('\n').length, 2)
    assert.equal(readFileSync(join(f.output, 'sample.svg'), 'utf8'), 'rendered')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('demo renderer rejects casts without visible output before invoking the renderer', () => {
  const f = fixture()
  try {
    writeFileSync(
      join(f.casts, 'sample.cast'),
      '{"version":2,"width":100,"height":24}\n[0,"o","\\u001b[0m"]\n'
    )
    const result = spawnSync(
      process.execPath,
      ['--import=@poppinss/ts-exec', renderer, f.casts, f.output],
      { env: f.env, encoding: 'utf8' }
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /No visible output/)
    assert.throws(() => readFileSync(f.env.TRACE), { code: 'ENOENT' })
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
