import { test } from '@japa/runner'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { countTests, planChecks, stepProblem } from '../../bin/check_changed_plan.js'

test.group('check_changed_plan.spec', (group) => {
  group.each.timeout(60_000)
  const plan = (...paths: string[]) =>
    Object.fromEntries(
      planChecks(
        paths.map((path) =>
          path.startsWith('-') ? { path: path.slice(1), deleted: true } : { path, deleted: false }
        )
      ).map((step) => [step.id, step])
    )

  test('a changed spec runs on its own and is formatted, linted and type-checked', () => {
    const steps = plan('tests/email.spec.ts')
    assert.deepEqual(steps.tests.command, ['pnpm', 'quick:test', '--files=tests/email.spec.ts'])
    assert.equal(steps.tests.tests, 'japa')
    assert.deepEqual(steps.format.command!.slice(-2), ['--', 'tests/email.spec.ts'])
    assert.deepEqual(steps.lint.command!.slice(-2), ['--', 'tests/email.spec.ts'])
    assert.ok(steps.lint.command!.includes('--no-warn-ignored'))
    assert.deepEqual(steps.typecheck.command, ['pnpm', 'typecheck'])
    assert.ok(steps.docs.skip)
    for (const id of ['format', 'lint', 'typecheck', 'tests'])
      assert.equal('skip' in steps[id], false)
  })

  test('named-file lint uses the root config, which ignores the example apps', () => {
    const steps = plan('examples/inertia-react/app/exceptions/handler.ts', 'src/index.ts')
    const config = steps.lint.command!.indexOf('--config')
    assert.equal(steps.lint.command![config + 1], 'eslint.config.js')
    assert.deepEqual(steps.lint.command!.slice(-2), [
      'examples/inertia-react/app/exceptions/handler.ts',
      'src/index.ts',
    ])
  })

  test('package sources build and check the built package; stubs/main.ts builds the docs', () => {
    for (const path of ['src/http/guard.ts', 'stubs/config/account_kit.stub', 'package.json']) {
      const steps = plan(path)
      assert.deepEqual(steps.build.command, ['pnpm', 'build'], path)
      assert.deepEqual(steps['built-exports'].command, ['pnpm', 'test:built-exports'], path)
      assert.deepEqual(steps['built-setup'].command, ['pnpm', 'test:built-setup'], path)
    }
    assert.ok(plan('tests/email.spec.ts').build.skip)
    assert.deepEqual(plan('stubs/main.ts').docs.command, ['pnpm', 'docs:build'])
  })

  test('formatting runs first, then lint, then type-checking and tests', () => {
    const ids = planChecks([{ path: 'src/http/guard.ts', deleted: false }]).map((step) => step.id)
    assert.deepEqual(ids.slice(0, 4), ['format', 'lint', 'typecheck', 'tests'])
  })

  test('--static leaves the full suite out and still runs changed specs', () => {
    const run = (...paths: string[]) =>
      Object.fromEntries(
        planChecks(
          paths.map((path) => ({ path, deleted: false })),
          { static: true }
        ).map((step) => [step.id, step])
      )
    const source = run('src/http/guard.ts')
    assert.ok(source.tests.skip)
    assert.ok(source['full-suite'].skip)
    assert.deepEqual(source.docs.command, ['pnpm', 'docs:build'])
    const spec = run('src/http/guard.ts', 'tests/email.spec.ts')
    assert.deepEqual(spec.tests.command, ['pnpm', 'quick:test', '--files=tests/email.spec.ts'])
    assert.equal(run('tests/email.spec.ts')['full-suite'], undefined)
    assert.equal(plan('src/http/guard.ts')['full-suite'], undefined)
  })

  test('changed source runs the full suite', () => {
    assert.deepEqual(plan('src/http/guard.ts', 'tests/email.spec.ts').tests.command, [
      'pnpm',
      'quick:test',
    ])
  })

  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'docs/guide/usage.md',
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
    const steps = plan('.github/dependabot.yml')
    assert.ok(steps.tests.skip)
    assert.ok(steps.typecheck.skip)
    assert.ok(steps.lint.skip)
    assert.deepEqual(steps.format.command!.slice(-2), ['--', '.github/dependabot.yml'])
  })

  test('workflow files run the Japa suite because workflow specs read them', () => {
    const steps = plan('.github/workflows/checks.yml')
    assert.deepEqual(steps.tests.command, ['pnpm', 'quick:test'])
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
  ] as [string, boolean, boolean][])
    test(`${path} checks the whole repository`, () => {
      const steps = plan(path)
      assert.equal(steps.format.command![1] === 'format:check', format)
      assert.equal(steps.lint.command?.[1] === 'lint', lint)
    })

  test('a lockfile-only change type-checks and builds the docs', () => {
    const steps = plan('pnpm-lock.yaml')
    assert.deepEqual(steps.typecheck.command, ['pnpm', 'typecheck'])
    assert.deepEqual(steps.docs.command, ['pnpm', 'docs:build'])
  })

  test('documentation sources build the docs; generated docs do not', () => {
    assert.deepEqual(plan('docs/guide/usage.md').docs.command, ['pnpm', 'docs:build'])
    assert.deepEqual(plan('typedoc.json').docs.command, ['pnpm', 'docs:build'])
    assert.ok(plan('docs/reference/api/index.md').docs.skip)
    assert.deepEqual(plan('src/http/guard.ts').docs.command, ['pnpm', 'docs:build'])
    assert.ok(plan('tests/email.spec.ts').docs.skip)
  })

  test('policy scripts run their own tests', () => {
    assert.deepEqual(plan('bin/pg.sh')['pg-service'].command, [
      'pnpm',
      'quick:test',
      '--files=tests/tooling/pg_service.spec.ts',
      '--files=tests/tooling/pg_service_inputs.spec.ts',
      '--files=tests/tooling/pg_service_process_safety.spec.ts',
    ])
    assert.ok(plan('bin/pg.sh').tests.skip)
    assert.deepEqual(
      plan('tests/helpers/pg_service_fixture.ts')['pg-service'].command,
      plan('bin/pg.sh')['pg-service'].command
    )
    assert.ok(plan('tests/helpers/pg_service_fixture.ts').tests.skip)
    assert.deepEqual(
      plan('tests/helpers/pg_service_fake_tools.ts')['pg-service'].command,
      plan('bin/pg.sh')['pg-service'].command
    )
    assert.ok(plan('tests/helpers/pg_service_fake_tools.ts').tests.skip)
    assert.deepEqual(plan('bin/helpers/consumer/fixture.ts').tests.command, ['pnpm', 'quick:test'])
    assert.deepEqual(plan('bin/check_changed_plan.ts')['check-changed'].command, [
      'pnpm',
      'quick:test',
      '--files=tests/tooling/check_changed_plan.spec.ts',
      '--files=tests/tooling/check_changed_process.spec.ts',
    ])
    assert.ok(plan('bin/check_changed_plan.ts').tests.skip)
    assert.deepEqual(
      plan('tests/tooling/check_changed_process.spec.ts')['check-changed'].command,
      plan('bin/check_changed_plan.ts')['check-changed'].command
    )
    assert.ok(plan('src/index.ts')['pg-service'].skip)
  })

  test('counts the tests each runner reported', () => {
    assert.equal(countTests('\u001b[2mTests\u001b[22m  3 passed (3)\n'), 3)
    assert.equal(countTests('Tests  1110 passed, 1 failed, 2 skipped (1113)'), 1113)
    assert.equal(countTests('Tests  0 passed (0)'), 0)
    assert.equal(countTests('no summary'), undefined)
    assert.equal(countTests('Tests  10 passed, 2 skipped (12)'), 12)
    assert.equal(countTests('  Tests  4 passed (4)\n'), 4)
  })

  test('a step fails on exit, timeout, zero tests or stale generated output', () => {
    const tests = { timeoutMs: 60_000, tests: 'japa' as const }
    const ok = { code: 0, timedOut: false, output: 'Tests  3 passed (3)' }
    assert.equal(stepProblem(tests, ok), undefined)
    assert.equal(stepProblem(tests, { ...ok, code: 1 }), 'exit 1')
    assert.equal(stepProblem(tests, { ...ok, timedOut: true }), 'stopped after 1 minutes')
    assert.equal(stepProblem(tests, { ...ok, output: 'Tests  0 passed (0)' }), 'ran no tests')
    assert.equal(
      stepProblem(tests, { ...ok, output: 'Tests  0 passed, 2 skipped (2)' }),
      'ran no tests'
    )
    assert.equal(stepProblem(tests, { ...ok, output: 'Tests  3 todo (3)' }), 'ran no tests')
    assert.equal(stepProblem(tests, { ...ok, output: 'Tests  1 passed, 2 skipped (3)' }), undefined)
    assert.equal(stepProblem(tests, { ...ok, output: 'Tests  1 regression (1)' }), undefined)
    assert.equal(stepProblem(tests, { ...ok, output: '' }), 'ran no tests')
    assert.equal(stepProblem({ timeoutMs: 60_000 }, { ...ok, output: '' }), undefined)
    assert.equal(
      stepProblem({ timeoutMs: 60_000 }, { ...ok, generatedChanged: true }),
      'committed generated output is stale'
    )
  })

  test('format:check skips a tracked file deleted from the working tree', () => {
    const root = join(import.meta.dirname, '..', '..')
    const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts[
      'format:check'
    ]
    const repo = mkdtempSync(join(tmpdir(), 'format-check-'))
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
      git('init', '-q')
      writeFileSync(join(repo, 'kept.js'), 'const kept = 1;\n')
      writeFileSync(join(repo, 'deleted.js'), 'const deleted = 1;\n')
      git('add', '.')
      unlinkSync(join(repo, 'deleted.js'))
      const result = spawnSync('sh', ['-c', script], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(root, 'node_modules', '.bin')}${delimiter}${process.env.PATH}`,
        },
      })
      assert.equal(result.status, 0, result.stdout + result.stderr)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
