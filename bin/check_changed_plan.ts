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
// `stubs/main.ts` is re-exported from `index.ts`; the other stubs are templates.
const docsInput = /^(?!tests\/|examples\/|bin\/)(?!stubs\/(?!main\.ts$)).+\.(?:ts|mts|cts)$/
// What the published package is built from: its sources, stubs, manifest and build settings.
const packageInput =
  /^(?:package\.json|tsdown\.config\.[^/]+|tsconfig[^/]*\.json|stubs\/.+|(?!tests\/|examples\/|bin\/|docs\/)[^/]+(?:\/[^/]+)*\.(?:ts|mts|cts))$/
const pgService =
  /^(?:bin\/pg\.sh|bin\/helpers\/pg_service_[^/]+\.ts|tests\/helpers\/pg_service_(?:fixture|fake_tools)\.ts|tests\/tooling\/pg_service(?:_inputs|_process_safety)?\.spec\.ts)$/
const checkChanged =
  /^(?:bin\/check_changed[^/]*\.ts|bin\/classify_changed\.mjs|tests\/tooling\/(?:check_changed_(?:plan|process)|classify_changed)\.spec\.ts)$/
// Files no Japa spec reads. Anything else may be read by a spec, so it runs the full suite.
// Markdown never qualifies: tests/docs_links.spec.ts reads tracked Markdown except changelogs.
// Workflows do not qualify either: workflow specs read `.github/workflows/*.yml`.
const outsideJapa =
  /^(?!.*\.md$)(?:\.github\/(?!workflows\/).+|bin\/pg\.sh|bin\/helpers\/pg_service_[^/]+\.ts|tests\/helpers\/pg_service_(?:fixture|fake_tools)\.ts|tests\/tooling\/.+|bin\/check_changed[^/]*\.ts|bin\/classify_changed\.mjs)$/

const minute = 60_000

/** The two change shapes `bin/classify_changed.mjs` gives a focused run; anything else is full. */
export type Classification = 'starter-pin-only' | 'root-readme-only' | 'full'
/** Specs that read the root README (through tracked Markdown globs). */
export const readmeSpecs = [
  'tests/docs_links.spec.ts',
  'tests/docs_snippets.spec.ts',
  'tests/docs_source_examples.spec.ts',
  'tests/docs_spec_references.spec.ts',
]
/** Specs that read `.github/workflows/*.yml`. */
export const workflowSpecs = [
  'tests/docs_release_checksum.spec.ts',
  'tests/examples_workflow.spec.ts',
  'tests/release_workflow.spec.ts',
  'tests/tooling/check_profiles.spec.ts',
]

export type CheckStep =
  | { id: string; command: string[]; tests?: 'japa'; timeoutMs: number; skip?: never }
  | { id: string; skip: string; command?: never; tests?: never; timeoutMs?: never }
/**
 * Plans checks for files changed since the merge base, including deleted paths.
 * The static option leaves out the full Japa suite.
 */
export function planChecks(
  files: { path: string; deleted: boolean }[],
  options: { static?: boolean; classification?: Classification } = {}
): CheckStep[] {
  if (options.classification && options.classification !== 'full')
    return focusedChecks(options.classification)
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
      ? ['pnpm', 'lint']
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
    [
      'pnpm',
      'quick:test',
      '--files=tests/tooling/check_changed_plan.spec.ts',
      '--files=tests/tooling/check_changed_process.spec.ts',
      '--files=tests/tooling/classify_changed.spec.ts',
    ],
    {
      tests: 'japa',
      skip: 'check:changed and its tests unchanged',
    }
  )
  // The built package: its exports and the packaged setup command and templates.
  for (const [id, command] of [
    ['build', ['pnpm', 'build']],
    ['built-exports', ['pnpm', 'test:built-exports']],
    ['built-setup', ['pnpm', 'test:built-setup']],
  ] as const)
    step(id, any(packageInput), [...command], {
      ...(id === 'build' ? {} : { tests: 'japa' as const }),
      skip: 'no package source changed',
    })
  step('docs', any(docsSource) || any(docsInput) || any(dependencies), ['pnpm', 'docs:build'], {
    timeoutMs: 10 * minute,
    skip: 'no documentation source changed',
  })
  return steps
}

/**
 * The checks for a narrow change shape: formatting of the one changed file and the specs that
 * read it. Every other step is skipped and says why.
 */
function focusedChecks(classification: Exclude<Classification, 'full'>): CheckStep[] {
  const [file, specs] =
    classification === 'root-readme-only'
      ? ['README.md', readmeSpecs]
      : ['.github/workflows/starter-examples.yml', workflowSpecs]
  const skip = `focused run for ${classification}`
  return [
    {
      id: 'format',
      command: ['pnpm', 'exec', 'prettier', '--check', '--', file],
      timeoutMs: 5 * minute,
    },
    { id: 'lint', skip },
    { id: 'typecheck', skip },
    {
      id: 'tests',
      command: ['pnpm', 'quick:test', ...specs.map((path) => `--files=${path}`)],
      tests: 'japa',
      timeoutMs: 5 * minute,
    },
    ...['pg-service', 'check-changed', 'build', 'built-exports', 'built-setup', 'docs'].map(
      (id) => ({ id, skip })
    ),
  ]
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
