import { test } from '@japa/runner'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify, classifyRepository, starterWorkflow } from '../../bin/classify_changed.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const modified = (path: string) => ({ path, status: 'M' })
const pinDiff = (from: string, to: string) =>
  `diff --git a/${starterWorkflow} b/${starterWorkflow}\n--- a/${starterWorkflow}\n+++ b/${starterWorkflow}\n@@ -11 +11 @@ env:\n-  STARTER_EXAMPLES_REF: ${from}\n+  STARTER_EXAMPLES_REF: ${to}\n`
const noDiff = (): string => {
  throw new Error('the diff is read for the pin file only')
}

test.group('classify_changed', () => {
  test('the pin-only diff of PR 810 is starter-pin-only', () => {
    const result = classify([modified(starterWorkflow)], () => pinDiff('v0.9.0', 'v0.10.0'))
    assert.equal(result.classification, 'starter-pin-only')
  })

  test('a root README edit on its own is root-readme-only', () => {
    assert.equal(classify([modified('README.md')], noDiff).classification, 'root-readme-only')
  })

  test('anything beyond the two shapes is full, with the first reason', () => {
    const full = (files: { path: string; status: string }[], diff: () => string = noDiff) =>
      classify(files, diff)
    assert.deepEqual(full([]), { classification: 'full', reason: 'no changed files' })
    assert.equal(
      full([modified(starterWorkflow), modified('src/index.ts')]).reason,
      'src/index.ts changed too'
    )
    assert.equal(
      full([modified('README.md'), modified('CHANGELOG.md')]).reason,
      'CHANGELOG.md changed too'
    )
    assert.equal(full([modified('README.md'), modified(starterWorkflow)]).classification, 'full')
    assert.equal(full([{ path: 'README.md', status: 'D' }]).reason, 'README.md is D')
    assert.equal(full([{ path: 'README.md', status: 'A' }]).classification, 'full')
    assert.equal(full([{ path: 'README.md', status: '?' }]).classification, 'full')
    assert.equal(
      full([modified('examples/api/README.md')]).reason,
      'examples/api/README.md changed'
    )
    assert.equal(full([modified('.github/workflows/checks.yml')]).classification, 'full')
    const secondHunk =
      pinDiff('v0.9.0', 'v0.10.0') +
      '@@ -20 +20 @@\n-    runs-on: ubuntu-24.04\n+    runs-on: ubuntu-latest\n'
    assert.match(
      full([modified(starterWorkflow)], () => secondHunk).reason,
      /changes more than the pin: - {4}runs-on/
    )
    const pinAndNeighbour = pinDiff('v0.9.0', 'v0.10.0').replace(
      '@@ -11 +11 @@ env:\n',
      '@@ -10,2 +10,2 @@\n-env:\n+env: # changed\n'
    )
    assert.equal(full([modified(starterWorkflow)], () => pinAndNeighbour).classification, 'full')
    assert.equal(full([modified(starterWorkflow)], () => '').reason, 'unparsable diff')
  })
})

test.group('classify_changed repository', (group) => {
  group.each.timeout(30_000)
  let repo: string
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  const commit = async (message: string, files: Record<string, string>) => {
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(join(repo, path, '..'), { recursive: true })
      await writeFile(join(repo, path), contents)
    }
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', message)
  }
  const workflow = (ref: string) =>
    `name: starter-examples\nenv:\n  STARTER_EXAMPLES_REF: ${ref}\njobs: {}\n`

  group.each.setup(async () => {
    repo = await mkdtemp(join(tmpdir(), 'classify-changed-'))
    git('init', '-q', '-b', 'main')
    await commit('base', {
      'README.md': '# Hello\n',
      [starterWorkflow]: workflow('v0.9.0'),
      'src/a.ts': '',
    })
    git('branch', 'base')
    return () => rm(repo, { recursive: true, force: true })
  })

  test('classifies real commits against the merge base', async () => {
    await commit('pin', { [starterWorkflow]: workflow('v0.10.0') })
    assert.equal(classifyRepository('base', repo).classification, 'starter-pin-only')
    await commit('readme', { 'README.md': '# Hello\n\nMore.\n' })
    assert.equal(classifyRepository('base', repo).reason, 'README.md changed too')
  })

  test('deleted and renamed files, untracked files and a missing base are full', async () => {
    await commit('readme', { 'README.md': '# Hello\n\nMore.\n' })
    assert.equal(classifyRepository('base', repo).classification, 'root-readme-only')
    await writeFile(join(repo, 'notes.txt'), 'untracked')
    assert.equal(classifyRepository('base', repo).reason, 'notes.txt changed too')
    await rm(join(repo, 'notes.txt'))
    git('mv', 'README.md', 'INTRO.md')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'rename')
    assert.equal(classifyRepository('base', repo).classification, 'full')
    assert.equal(classifyRepository('no-such-ref', repo).reason, 'no merge base with no-such-ref')
    assert.equal(classifyRepository('', repo).reason, 'no base ref')
    assert.equal(
      classifyRepository('0000000000000000000000000000000000000000', repo).classification,
      'full'
    )
  })

  test('the command prints the classification and writes the workflow outputs', async () => {
    await commit('pin', { [starterWorkflow]: workflow('v0.10.0') })
    const output = join(repo, 'github-output')
    const stdout = execFileSync(
      process.execPath,
      [join(repository, 'bin/classify_changed.mjs'), 'base'],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: output },
      }
    )
    assert.match(
      stdout,
      /^classification=starter-pin-only\nreason=only the STARTER_EXAMPLES_REF pin changed\n$/
    )
    assert.equal(await readFile(output, 'utf8'), 'classification=starter-pin-only\nfocused=true\n')
    const full = execFileSync(process.execPath, [join(repository, 'bin/classify_changed.mjs')], {
      cwd: repo,
      encoding: 'utf8',
    })
    assert.match(full, /^classification=full\nreason=no base ref\n$/)
  })
})
