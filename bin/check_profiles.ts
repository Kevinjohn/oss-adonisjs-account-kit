/** One `pnpm` script run by `pnpm check`, optionally inside an example application. */
export interface CheckStep {
  script: string
  args?: string[]
  directory?: string
  env?: Record<string, string>
}
export type CheckProfile = 'quick' | 'full'

function packageChecks(sqliteTest: 'quick:test' | 'test'): CheckStep[] {
  return [
    { script: 'format:check' },
    { script: 'lint' },
    { script: 'typecheck' },
    { script: sqliteTest },
    { script: 'build' },
    { script: 'test:built-exports' },
    { script: 'test:built-setup' },
  ]
}

/** The full profile uses the covered SQLite run and adds compatibility and documentation checks. */
export const checkProfiles: Record<CheckProfile, CheckStep[]> = {
  quick: packageChecks('quick:test'),
  full: [
    ...packageChecks('test'),
    { script: 'test:pg' },
    { script: 'test:mysql' },
    { script: 'test:consumer' },
    { script: 'test:recipe', args: ['--recipe=api-password-reset'] },
    { script: 'docs:build' },
  ],
}

export function selectedSteps(flags: string[]): CheckStep[] {
  const unknown = flags.filter((flag) => flag !== '--full')
  if (unknown.length > 0) throw new Error(`Use pnpm check [--full]; got ${unknown}`)
  return [...checkProfiles[flags.includes('--full') ? 'full' : 'quick']]
}
