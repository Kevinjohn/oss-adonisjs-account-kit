// Map a branch's changed files to the checks that cover them. Pure: no file system or processes.

const lintable = /\.(?:ts|mts|cts|js|mjs|cjs)$/
const typed = /(?:\.(?:ts|mts|cts)$|^tsconfig[^/]*\.json$|^package\.json$|^pnpm-lock\.yaml$)/
const dependencies = /^(?:package\.json|pnpm-lock\.yaml)$/
// A change to these can break files that did not change, so the whole repository is checked.
const formatConfig = /^(?:\.prettierignore|\.prettierrc[^/]*|prettier\.config\.[^/]+)$/
const lintConfig = /^eslint\.config\.[^/]+$/
const spec = /^tests\/.+\.spec\.ts$/
const docsSource = /^(?:docs\/(?!reference\/api\/|\.vitepress\/(?:cache|dist)\/).+|typedoc\.json)$/
// TypeDoc reads the exported sources and fails on warnings, so source changes build the docs too.
const docsInput = /^(?!tests\/|examples\/|stubs\/|bin\/).+\.(?:ts|mts|cts)$/
const pgService =
  /^(?:bin\/pg\.sh|bin\/helpers\/pg_service_[^/]+\.ts|tests\/tooling\/pg_service(?:_inputs|_process_safety)?\.spec\.ts)$/
const checkChanged =
  /^(?:bin\/check_changed[^/]*\.ts|tests\/tooling\/check_changed_plan\.spec\.ts)$/
// Files no Japa spec reads. Anything else may be read by a spec, so it runs the full suite.
// Markdown never qualifies: tests/docs_links.spec.ts reads tracked Markdown except changelogs.
const outsideJapa =
  /^(?!.*\.md$)(?:\.github\/.+|bin\/pg\.sh|bin\/helpers\/pg_service_[^/]+\.ts|tests\/tooling\/.+|bin\/check_changed[^/]*\.ts)$/

const minute = 60_000

export type CheckStep =
  | { id: string; command: string[]; tests?: 'japa'; timeoutMs: number; skip?: never }
  | { id: string; skip: string; command?: never; tests?: never; timeoutMs?: never }
/**
 * Plans checks for files changed since the merge base, including deleted paths.
 * The static option leaves out the full Japa suite.
 */
export function planChecks(
  files: { path: string; deleted: boolean }[],
  options: { static?: boolean } = {}
): CheckStep[] {
  const present = files.filter((file) => !file.deleted).map((file) => file.path)
  const any = (pattern: RegExp) => files.some((file) => pattern.test(file.path))
  const steps: CheckStep[] = []
  const step = (
    id: string,
    run: boolean,
    command: string[],
    { skip, ...stepOptions }: { skip?: string; tests?: 'japa'; timeoutMs?: number }
  ) =>
    steps.push(
      run ? { id, command, timeoutMs: 5 * minute, ...stepOptions } : { id, skip: skip ?? '' }
    )

  // Formatting runs first, then lint, then everything else.
  const prettier = ['pnpm', 'exec', 'prettier', '--check']
  step(
    'format',
    present.length > 0 || any(formatConfig) || any(dependencies),
    any(formatConfig) || any(dependencies)
      ? ['pnpm', 'format:check']
      : [...prettier, '--ignore-unknown', '--no-error-on-unmatched-pattern', '--', ...present],
    { skip: 'no existing changed files' }
  )
  const lintFiles = present.filter((path) => lintable.test(path))
  // ESLint looks up the config nearest each named file, so an example app's own config (and its
  // uninstalled plugins) would load. The root config ignores examples, as `pnpm lint` does.
  step(
    'lint',
    lintFiles.length > 0 || any(lintConfig) || any(dependencies),
    any(lintConfig) || any(dependencies)
      ? ['pnpm', 'lint', '--max-warnings', '0']
      : [
          'pnpm',
          'exec',
          'eslint',
          '--config',
          'eslint.config.js',
          '--max-warnings',
          '0',
          '--no-warn-ignored',
          '--',
          ...lintFiles,
        ],
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

  step(
    'pg-service',
    any(pgService),
    [
      'pnpm',
      'quick:test',
      '--files=tests/tooling/pg_service.spec.ts',
      '--files=tests/tooling/pg_service_inputs.spec.ts',
      '--files=tests/tooling/pg_service_process_safety.spec.ts',
    ],
    {
      tests: 'japa',
      skip: 'pg.sh and its tests unchanged',
    }
  )
  step(
    'check-changed',
    any(checkChanged),
    ['pnpm', 'quick:test', '--files=tests/tooling/check_changed_plan.spec.ts'],
    {
      tests: 'japa',
      skip: 'check:changed and its tests unchanged',
    }
  )
  step('docs', any(docsSource) || any(docsInput) || any(dependencies), ['pnpm', 'docs:build'], {
    timeoutMs: 10 * minute,
    skip: 'no documentation source changed',
  })
  return steps
}

/**
 * Count the tests a runner reported, or undefined when its summary is missing.
 * @param {string} output
 */
export function countTests(output: string) {
  // Strip terminal ANSI escapes before reading the runner summary.
  // eslint-disable-next-line no-control-regex
  const text = output.replace(/\u001b\[[0-9;]*m/g, '')
  const match = /^\s*Tests\s+.*\((\d+)\)\s*$/m.exec(text)
  return match ? Number(match[1]) : undefined
}

/** Count executed test cases, excluding Japa's skipped and todo cases. */
function countExecutedTests(output: string) {
  // Strip terminal ANSI escapes before reading the runner summary.
  // eslint-disable-next-line no-control-regex
  const text = output.replace(/\u001b\[[0-9;]*m/g, '')
  const summary = /^\s*Tests\s+(.+)\(\d+\)\s*$/m.exec(text)?.[1] ?? ''
  return [...summary.matchAll(/(?:^|,\s*)(\d+)\s+(passed|failed|regression)\b/g)].reduce(
    (total, match) => total + Number(match[1]),
    0
  )
}

/**
 * Why a step that ran failed, or undefined when it passed.
 * @param {{ timeoutMs: number, tests?: 'japa' }} step
 * @param {{ code: number | null, timedOut: boolean, output: string, generatedChanged?: boolean }} result
 */
export function stepProblem(
  step: { timeoutMs: number; tests?: 'japa' },
  result: { code: number | null; timedOut: boolean; output: string; generatedChanged?: boolean }
) {
  if (result.timedOut) return `stopped after ${step.timeoutMs / minute} minutes`
  if (result.code !== 0) return `exit ${result.code}`
  if (step.tests && (!countTests(result.output) || !countExecutedTests(result.output)))
    return 'ran no tests'
  if (result.generatedChanged) return 'committed generated output is stale'
}
