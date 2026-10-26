import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countTests, planChecks, stepProblem } from '../check_changed_plan.mjs'

const plan = (...paths) =>
  Object.fromEntries(
    planChecks(
      paths.map((path) =>
        path.startsWith('-') ? { path: path.slice(1), deleted: true } : { path, deleted: false }
      )
    ).map((step) => [step.id, step])
  )

test('a changed spec runs on its own and is formatted, linted and type-checked', () => {
  const steps = plan('tests/unit/email.spec.ts')
  assert.deepEqual(steps.tests.command, ['pnpm', 'quick:test', '--files=tests/unit/email.spec.ts'])
  assert.equal(steps.tests.tests, 'japa')
  assert.deepEqual(steps.format.command.slice(-2), ['--', 'tests/unit/email.spec.ts'])
  assert.deepEqual(steps.lint.command.slice(-2), ['--', 'tests/unit/email.spec.ts'])
  assert.ok(steps.lint.command.includes('--no-warn-ignored'))
  assert.deepEqual(steps.typecheck.command, ['pnpm', 'typecheck'])
  assert.ok(steps.docs.skip)
  for (const id of ['format', 'lint', 'typecheck', 'tests'])
    assert.equal('skip' in steps[id], false)
})

test('changed source runs the full suite', () => {
  assert.deepEqual(plan('src/http/guard.ts', 'tests/unit/email.spec.ts').tests.command, [
    'pnpm',
    'quick:test',
  ])
})

for (const path of [
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'docs/usage.md',
  '.gitignore',
])
  test(`configuration or a file specs read (${path}) runs the full suite`, () => {
    assert.deepEqual(plan(path).tests.command, ['pnpm', 'quick:test'])
  })

test('deleted files select checks but are never passed by name', () => {
  const steps = plan('-src/old.ts', '-tests/old.spec.ts')
  assert.ok(steps.format.skip)
  assert.ok(steps.lint.skip)
  assert.deepEqual(steps.typecheck.command, ['pnpm', 'typecheck'])
  assert.deepEqual(steps.tests.command, ['pnpm', 'quick:test'])
})

test('files no spec reads skip the Japa suite', () => {
  const steps = plan('.github/workflows/checks.yml')
  assert.ok(steps.tests.skip)
  assert.ok(steps.typecheck.skip)
  assert.ok(steps.lint.skip)
  assert.deepEqual(steps.format.command.slice(-2), ['--', '.github/workflows/checks.yml'])
})

for (const path of ['LICENSE.md', '.github/pull_request_template.md', '-LICENSE.md'])
  test(`Markdown (${path}) runs the full suite, which checks every Markdown link`, () => {
    assert.deepEqual(plan(path).tests.command, ['pnpm', 'quick:test'])
  })

for (const [path, format, lint] of [
  ['eslint.config.js', false, true],
  ['.prettierignore', true, false],
  ['package.json', true, true],
  ['pnpm-lock.yaml', true, true],
])
  test(`${path} checks the whole repository`, () => {
    const steps = plan(path)
    assert.equal(steps.format.command.at(-1) === '.', format)
    assert.equal(steps.lint.command?.[1] === 'lint', lint)
  })

test('a lockfile-only change type-checks and builds the docs', () => {
  const steps = plan('pnpm-lock.yaml')
  assert.deepEqual(steps.typecheck.command, ['pnpm', 'typecheck'])
  assert.deepEqual(steps.docs.command, ['pnpm', 'docs:build'])
})

test('documentation sources build the docs; generated docs do not', () => {
  assert.deepEqual(plan('docs/usage.md').docs.command, ['pnpm', 'docs:build'])
  assert.deepEqual(plan('typedoc.json').docs.command, ['pnpm', 'docs:build'])
  assert.ok(plan('docs/api/index.md').docs.skip)
  assert.deepEqual(plan('src/http/guard.ts').docs.command, ['pnpm', 'docs:build'])
  assert.ok(plan('tests/unit/email.spec.ts').docs.skip)
})

test('policy scripts run their own tests', () => {
  assert.deepEqual(plan('bin/pg.sh')['pg-service'].command, ['pnpm', 'test:pg-service'])
  assert.ok(plan('bin/pg.sh').tests.skip)
  assert.deepEqual(plan('scripts/check_changed_plan.mjs')['check-changed'].command, [
    'pnpm',
    'test:check-changed',
  ])
  assert.ok(plan('scripts/check_changed_plan.mjs').tests.skip)
  assert.ok(plan('src/index.ts')['pg-service'].skip)
})

test('counts the tests each runner reported', () => {
  assert.equal(countTests('japa', '\u001b[2mTests\u001b[22m  3 passed (3)\n'), 3)
  assert.equal(countTests('japa', 'Tests  1110 passed, 1 failed, 2 skipped (1113)'), 1113)
  assert.equal(countTests('japa', 'Tests  0 passed (0)'), 0)
  assert.equal(countTests('japa', 'no summary'), undefined)
  assert.equal(countTests('node', '# tests 12\n# pass 12'), 12)
  assert.equal(countTests('node', 'ℹ tests 4\nℹ pass 4'), 4)
})

test('a step fails on exit, timeout, zero tests or stale generated output', () => {
  const tests = { timeoutMs: 60_000, tests: 'japa' }
  const ok = { code: 0, timedOut: false, output: 'Tests  3 passed (3)' }
  assert.equal(stepProblem(tests, ok), undefined)
  assert.equal(stepProblem(tests, { ...ok, code: 1 }), 'exit 1')
  assert.equal(stepProblem(tests, { ...ok, timedOut: true }), 'stopped after 1 minutes')
  assert.equal(stepProblem(tests, { ...ok, output: 'Tests  0 passed (0)' }), 'ran no tests')
  assert.equal(stepProblem(tests, { ...ok, output: '' }), 'ran no tests')
  assert.equal(stepProblem({ timeoutMs: 60_000 }, { ...ok, output: '' }), undefined)
  assert.equal(
    stepProblem({ timeoutMs: 60_000 }, { ...ok, generatedChanged: true }),
    'committed generated output is stale'
  )
})
