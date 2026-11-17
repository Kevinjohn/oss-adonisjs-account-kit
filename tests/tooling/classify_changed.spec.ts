import { test } from '@japa/runner'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify, classifyRepository, rootReadme } from '../../bin/classify_changed.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const modified = (path: string) => ({ path, status: 'M' })

test.group('classify_changed', () => {
  test('a root README edit on its own is root-readme-only', () => {
    assert.deepEqual(classify([modified(rootReadme)]), {
      classification: 'root-readme-only',
      reason: 'only README.md changed',
    })
  })

  test('anything beyond a modified root README is full', () => {
    assert.deepEqual(classify([]), { classification: 'full', reason: 'no changed files' })
    assert.equal(
      classify([modified(rootReadme), modified('src/index.ts')]).reason,
      'src/index.ts changed too'
    )
    assert.equal(
      classify([modified(rootReadme), modified('.github/workflows/release.yml')]).classification,
      'full'
    )
    assert.equal(classify([{ path: rootReadme, status: 'D' }]).reason, 'README.md is D')
    assert.equal(classify([{ path: rootReadme, status: 'A' }]).classification, 'full')
    assert.equal(classify([{ path: rootReadme, status: '?' }]).classification, 'full')
    assert.equal(
      classify([modified('.github/workflows/release.yml')]).reason,
      '.github/workflows/release.yml changed'
    )
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

  group.each.setup(async () => {
    repo = await mkdtemp(join(tmpdir(), 'classify-changed-'))
    git('init', '-q', '-b', 'main')
    await commit('base', {
      'README.md': '# Hello\n',
      '.github/workflows/release.yml': 'name: release\n',
      'src/a.ts': '',
    })
    git('branch', 'base')
    return () => rm(repo, { recursive: true, force: true })
  })

  test('classifies real commits against the merge base', async () => {
    await commit('readme', { 'README.md': '# Hello\n\nMore.\n' })
    assert.equal(classifyRepository('base', repo).classification, 'root-readme-only')
    await commit('workflow', { '.github/workflows/release.yml': 'name: release\njobs: {}\n' })
    assert.equal(classifyRepository('base', repo).classification, 'full')
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
    await commit('readme', { 'README.md': '# Hello\n\nMore.\n' })
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
    assert.match(stdout, /^classification=root-readme-only\nreason=only README.md changed\n$/)
    assert.equal(await readFile(output, 'utf8'), 'classification=root-readme-only\nfocused=true\n')
    const full = execFileSync(process.execPath, [join(repository, 'bin/classify_changed.mjs')], {
      cwd: repo,
      encoding: 'utf8',
    })
    assert.match(full, /^classification=full\nreason=no base ref\n$/)
  })
})
