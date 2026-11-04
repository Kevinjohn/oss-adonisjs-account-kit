import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from '@japa/runner'
import { checkProfiles, selectedSteps } from '../../bin/check_profiles.js'

const root = join(import.meta.dirname, '../..')
const allSteps = Object.values(checkProfiles).flat()

function scripts(directory = ''): Record<string, string> {
  return JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')).scripts
}

test('every check step names an existing script', ({ assert }) => {
  const missing = allSteps.filter((step) => !(step.script in scripts(step.directory)))
  assert.deepEqual(missing, [])
})

test('the check profiles cover every pnpm script the CI workflows run', ({ assert }) => {
  const covered = new Set(allSteps.map((step) => step.script))
  const ignored = new Set(['install', 'dlx', 'add', 'list', 'update', 'pack', 'exec', '--dir'])
  // PostgreSQL lifecycle commands provision and clean up the consumer job; they are not gates.
  const prerequisites = new Set(['pg:start', 'pg:stop'])
  const uncovered = ['checks.yml', 'compat.yml', 'examples.yml', 'docs.yml'].flatMap((workflow) =>
    [
      ...readFileSync(join(root, '.github/workflows', workflow), 'utf8').matchAll(
        /\bpnpm ([a-z][\w:-]*)/g
      ),
    ]
      .map((match) => match[1])
      .filter(
        (script) => !ignored.has(script) && !prerequisites.has(script) && !covered.has(script)
      )
      .map((script) => `${workflow}: ${script}`)
  )
  assert.deepEqual(uncovered, [])
})

test('full adds to the quick profile and unknown flags are rejected', ({ assert }) => {
  assert.deepEqual(selectedSteps([]), checkProfiles.quick)
  assert.deepEqual(selectedSteps(['--full']), [...checkProfiles.quick, ...checkProfiles.full])
  assert.throws(() => selectedSteps(['--fast']), /pnpm check/)
})

test('the full recipe step selects committed inputs and check forwards its arguments', ({
  assert,
}) => {
  const recipe = checkProfiles.full.find((step) => step.script === 'test:recipe')
  if (!recipe) throw new Error('The full profile recipe step is missing')
  assert.deepEqual(recipe.args, ['--recipe=api-password-reset'])
  assert.isTrue(
    existsSync(join(root, 'docs/recipes/patches/api-password-reset.patch')),
    'the selected recipe patch is committed'
  )
  assert.isTrue(
    existsSync(join(root, 'examples/api/tests/recipes/api-password-reset.spec.ts')),
    'the selected recipe acceptance spec is committed'
  )

  const checkRunner = readFileSync(join(root, 'bin/check.ts'), 'utf8')
  assert.match(checkRunner, /\['pnpm', step\.script, \.\.\.\(step\.args \?\? \[\]\)\]/)
  assert.match(checkRunner, /spawnSync\('pnpm', \[step\.script, \.\.\.\(step\.args \?\? \[\]\)\]/)
})

test('format:check covers tracked files only and tolerates an unstaged deletion', ({ assert }) => {
  const directory = mkdtempSync(join(tmpdir(), 'format-check-'))
  const formatCheck = () =>
    spawnSync('sh', ['-c', scripts()['format:check']], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${join(root, 'node_modules/.bin')}${delimiter}${process.env.PATH}`,
      },
    }).status

  try {
    execFileSync('git', ['init', '-q'], { cwd: directory })
    writeFileSync(join(directory, 'kept.ts'), 'export const kept = 1;\n')
    writeFileSync(join(directory, 'deleted.ts'), 'export const deleted = 1;\n')
    execFileSync('git', ['add', '.'], { cwd: directory })
    rmSync(join(directory, 'deleted.ts'))
    writeFileSync(join(directory, 'untracked.ts'), 'export   const untracked={a:1}\n')
    assert.equal(formatCheck(), 0)

    writeFileSync(join(directory, 'kept.ts'), 'export   const kept=1\n')
    assert.notEqual(formatCheck(), 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
