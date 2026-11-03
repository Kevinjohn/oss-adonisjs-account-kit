import { test } from '@japa/runner'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const helper = resolve('bin/prepare_example_archive.ts')
const baseManifest = {
  name: 'adonisjs-account-kit',
  version: '0.2.0',
  engines: { node: '>=24.0.0' },
  peerDependencies: { '@adonisjs/core': '^7.0.0' },
  peerDependenciesMeta: { '@adonisjs/core': { optional: true } },
}
const entry = `  adonisjs-account-kit@file:vendor/adonisjs-account-kit.tgz:
    resolution: {integrity: sha512-old, tarball: file:vendor/adonisjs-account-kit.tgz}
    version: 0.0.0
    engines: {node: '>=24.0.0'}
    peerDependencies:
      '@adonisjs/core': ^7.0.0
    peerDependenciesMeta:
      '@adonisjs/core':
        optional: true`

function fixture(manifest = baseManifest, packageEntry = entry) {
  const directory = mkdtempSync(join(tmpdir(), 'example-archive-'))
  mkdirSync(join(directory, 'vendor'))
  mkdirSync(join(directory, 'package'))
  writeFileSync(join(directory, 'package/package.json'), JSON.stringify(manifest))
  const archive = join(directory, 'vendor/adonisjs-account-kit.tgz')
  execFileSync('tar', ['-czf', archive, '-C', directory, 'package'])
  const lock = `lockfileVersion: '9.0'\n\npackages:\n\n${packageEntry}\n\n  unrelated@1.0.0:\n    resolution: {integrity: sha512-unchanged}\n`
  const path = join(directory, 'pnpm-lock.yaml')
  writeFileSync(path, lock)
  return { directory, archive, path, lock }
}

function run(directory: string) {
  return spawnSync(process.execPath, ['--import=@poppinss/ts-exec', helper, directory], {
    encoding: 'utf8',
  })
}

test('reconciles the packed manifest version and hash while preserving the pinned graph', ({
  assert,
}) => {
  const f = fixture()
  try {
    const result = run(f.directory)
    assert.equal(result.status, 0, result.stderr)
    const hash = createHash('sha512').update(readFileSync(f.archive)).digest('base64')
    assert.equal(
      readFileSync(f.path, 'utf8'),
      f.lock.replace('sha512-old', `sha512-${hash}`).replace('version: 0.0.0', 'version: 0.2.0')
    )
  } finally {
    rmSync(f.directory, { recursive: true, force: true })
  }
})

for (const [name, packageEntry, message] of [
  ['missing entry', '', 'exactly one candidate'],
  ['duplicate entries', `${entry}\n\n${entry}`, 'exactly one candidate'],
  [
    'wrong archive path',
    entry.replace('tarball: file:vendor/', 'tarball: file:other/'),
    'archive resolution path',
  ],
  ['different peers', entry.replace('^7.0.0', '^8.0.0'), 'metadata changed'],
  ['changed peer range whitespace', entry.replace('^7.0.0', '^7. 0.0'), 'metadata changed'],
]) {
  test(`rejects ${name} without modifying the lockfile`, ({ assert }) => {
    const f = fixture(baseManifest, packageEntry)
    try {
      const result = run(f.directory)
      assert.notEqual(result.status, 0)
      assert.include(result.stderr, message)
      assert.equal(readFileSync(f.path, 'utf8'), f.lock)
    } finally {
      rmSync(f.directory, { recursive: true, force: true })
    }
  })
}

for (const field of ['bundleDependencies', 'bundledDependencies']) {
  test(`rejects boolean ${field} without modifying the lockfile`, ({ assert }) => {
    const f = fixture({ ...baseManifest, [field]: true })
    try {
      const result = run(f.directory)
      assert.notEqual(result.status, 0)
      assert.include(result.stderr, `Candidate ${field} changed`)
      assert.equal(readFileSync(f.path, 'utf8'), f.lock)
    } finally {
      rmSync(f.directory, { recursive: true, force: true })
    }
  })
}
