// Map a branch's changed files to the checks that cover them. Pure: no file system or processes.

const lintable = /\.(?:ts|mts|cts|js|mjs|cjs)$/
const typed = /(?:\.(?:ts|mts|cts)$|^tsconfig[^/]*\.json$|^package\.json$|^pnpm-lock\.yaml$)/
const dependencies = /^(?:package\.json|pnpm-lock\.yaml)$/
// A change to these can break files that did not change, so the whole repository is checked.
const formatConfig = /^(?:\.prettierignore|\.prettierrc[^/]*|prettier\.config\.[^/]+)$/
const lintConfig = /^eslint\.config\.[^/]+$/
const spec = /^tests\/.+\.spec\.ts$/
const docsSource = /^(?:docs\/(?!api\/|\.vitepress\/(?:cache|dist)\/).+|typedoc\.json)$/
// TypeDoc reads the exported sources and fails on warnings, so source changes build the docs too.
const docsInput = /^(?!tests\/|examples\/|stubs\/|scripts\/).+\.(?:ts|mts|cts)$/
const pgService =
  /^(?:bin\/pg\.sh|scripts\/test_pg_service\.mjs|scripts\/(?:tests|helpers)\/pg_service_[^/]+\.mjs)$/
const checkChanged = /^scripts\/(?:tests\/)?check_changed[^/]*\.mjs$/
// Files no Japa spec reads. Anything else may be read by a spec, so it runs the full suite.
// Markdown never qualifies: tests/docs_links.spec.ts reads every tracked Markdown file.
const outsideJapa =
  /^(?!.*\.md$)(?:\.github\/.+|bin\/pg\.sh|scripts\/(?:tests|helpers)\/.+|scripts\/test_pg_service\.mjs|scripts\/check_changed[^/]*\.mjs)$/

const minute = 60_000

/**
 * @param {{ path: string, deleted: boolean }[]} files changed since the merge base
 * @param {{ static?: boolean }} options `static` leaves the full Japa suite out
 * @returns {({ id: string, command: string[], tests?: 'japa' | 'node', timeoutMs: number } | { id: string, skip: string })[]}
 */
export function planChecks(files, options = {}) {
  const present = files.filter((file) => !file.deleted).map((file) => file.path)
  const any = (pattern) => files.some((file) => pattern.test(file.path))
  const steps = []
  const step = (id, run, command, { skip, ...options }) =>
    steps.push(run ? { id, command, timeoutMs: 5 * minute, ...options } : { id, skip })

  const prettier = ['pnpm', 'exec', 'prettier', '--check']
  step(
    'format',
    present.length > 0 || any(formatConfig) || any(dependencies),
    any(formatConfig) || any(dependencies)
      ? [...prettier, '.']
      : [...prettier, '--ignore-unknown', '--no-error-on-unmatched-pattern', '--', ...present],
    { skip: 'no existing changed files' }
  )
  const lintFiles = present.filter((path) => lintable.test(path))
  step(
    'lint',
    lintFiles.length > 0 || any(lintConfig) || any(dependencies),
    any(lintConfig) || any(dependencies)
      ? ['pnpm', 'lint', '--max-warnings', '0']
      : ['pnpm', 'exec', 'eslint', '--max-warnings', '0', '--no-warn-ignored', '--', ...lintFiles],
    { skip: 'no changed source files' }
  )
  step('typecheck', any(typed), ['pnpm', 'typecheck'], {
    skip: 'no TypeScript or type configuration changed',
  })

  const full = files.some(
    (file) => !outsideJapa.test(file.path) && !(spec.test(file.path) && !file.deleted)
  )
  const specs = present.filter((path) => spec.test(path))
  if (full && !options.static) {
    step('tests', true, ['pnpm', 'quick:test'], {
      tests: 'japa',
      timeoutMs: 15 * minute,
      skip: undefined,
    })
  } else {
    step(
      'tests',
      specs.length > 0,
      ['pnpm', 'quick:test', ...specs.map((path) => `--files=${path}`)],
      {
        tests: 'japa',
        skip: full ? 'no changed spec files' : 'no file the Japa suite reads changed',
      }
    )
  }
  if (full && options.static) steps.push({ id: 'full-suite', skip: '--static leaves it out' })

  step('pg-service', any(pgService), ['pnpm', 'test:pg-service'], {
    tests: 'node',
    skip: 'pg.sh and its tests unchanged',
  })
  step('check-changed', any(checkChanged), ['pnpm', 'test:check-changed'], {
    tests: 'node',
    skip: 'check:changed and its tests unchanged',
  })
  step('docs', any(docsSource) || any(docsInput) || any(dependencies), ['pnpm', 'docs:build'], {
    timeoutMs: 10 * minute,
    skip: 'no documentation source changed',
  })
  return steps
}

/**
 * Count the tests a runner reported, or undefined when its summary is missing.
 * @param {'japa' | 'node'} runner
 * @param {string} output
 */
export function countTests(runner, output) {
  const text = output.replace(/\u001b\[[0-9;]*m/g, '')
  const match =
    runner === 'japa'
      ? /^\s*Tests\s+.*\((\d+)\)\s*$/m.exec(text)
      : /^(?:#|ℹ)\s*tests\s+(\d+)\s*$/m.exec(text)
  return match ? Number(match[1]) : undefined
}

/**
 * Why a step that ran failed, or undefined when it passed.
 * @param {{ timeoutMs: number, tests?: 'japa' | 'node' }} step
 * @param {{ code: number | null, timedOut: boolean, output: string, generatedChanged?: boolean }} result
 */
export function stepProblem(step, result) {
  if (result.timedOut) return `stopped after ${step.timeoutMs / minute} minutes`
  if (result.code !== 0) return `exit ${result.code}`
  if (step.tests && !countTests(step.tests, result.output)) return 'ran no tests'
  if (result.generatedChanged) return 'committed generated output is stale'
}
