// Setup planning phase: selected package presence, limiter store and version range diagnostics.
import type { SetupChoices, SetupInspection, SetupDiagnostic } from './types.js'
import { hasEmailFlow, diagnostic } from './shared.js'
import { limiterConfigurationState } from './config_inspection.js'

export async function planDependencies(
  choices: SetupChoices,
  state: SetupInspection,
  diagnostics: SetupDiagnostic[]
): Promise<string[]> {
  const selectedPackages = [
    'typescript',
    '@adonisjs/core',
    '@adonisjs/lucid',
    '@adonisjs/limiter',
    'adonisjs-account-kit',
    ...(choices.managed.length ? ['@adonisjs/auth', '@vinejs/vine'] : []),
    ...(choices.authentication?.strategy === 'session' && choices.managed.length
      ? ['@adonisjs/session', '@adonisjs/shield']
      : []),
    ...(hasEmailFlow(choices) && choices.mail.integration === 'adonisjs-mail'
      ? ['@adonisjs/mail']
      : []),
    ...(choices.social.status === 'enabled' ? ['@adonisjs/ally'] : []),
  ]
  const missingPackages = selectedPackages.filter((name) => !state.installedPackages.includes(name))
  for (const name of missingPackages)
    diagnostic(diagnostics, `dependencies.${name}`, `Install ${name} explicitly before applying`)
  const limiter = await limiterConfigurationState(
    state.files['config/limiter.ts'] ?? '',
    state.root
  )
  if (limiter === 'invalid')
    diagnostic(
      diagnostics,
      'config/limiter.ts',
      'Configure @adonisjs/limiter with pnpm exec node ace configure @adonisjs/limiter; config/limiter.ts needs an actual selected store in its exported defineConfig'
    )
  else if (limiter === 'unresolved')
    diagnostic(
      diagnostics,
      'config/limiter.ts',
      'Selected limiter store is unresolved; use a direct literal or a resolvable environment assignment before activation'
    )
  const minimumVersions: Record<string, readonly [number, number, number]> = {
    '@adonisjs/core': [7, 0, 0],
    '@adonisjs/lucid': [22, 4, 2],
    '@adonisjs/limiter': [3, 0, 0],
    '@adonisjs/auth': [10, 1, 0],
    '@adonisjs/session': [8, 1, 0],
    '@adonisjs/shield': [9, 0, 0],
    '@vinejs/vine': [4, 4, 0],
    '@adonisjs/mail': [10, 0, 0],
  }
  for (const name of selectedPackages) {
    if (name === 'typescript') {
      const version = state.installedVersions[name]
      const parts = version
        ?.match(/^(\d+)\.(\d+)\.(\d+)$/)
        ?.slice(1)
        .map(Number)
      const supported =
        parts &&
        ((parts[0] === 5 && (parts[1] > 9 || (parts[1] === 9 && parts[2] >= 3))) ||
          (parts[0] === 6 && (parts[1] > 0 || parts[2] >= 3)))
      if (!supported)
        diagnostic(
          diagnostics,
          'dependencies.typescript',
          `Installed TypeScript version ${version ?? 'unknown'} is outside supported ^5.9.3 || ^6.0.3 range`
        )
      continue
    }
    const minimum = minimumVersions[name]
    if (!minimum) continue
    const version = state.installedVersions[name]
    if (!version) continue
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/)
    const parts = match?.slice(1).map(Number)
    if (
      !parts ||
      parts[0] !== minimum[0] ||
      parts[1] < minimum[1] ||
      (parts[1] === minimum[1] && parts[2] < minimum[2])
    )
      diagnostic(
        diagnostics,
        `dependencies.${name}`,
        `Installed ${name}@${version} is outside supported ^${minimum.join('.')} range`
      )
  }
  if (choices.social.status === 'enabled') {
    const allyVersion = state.installedVersions['@adonisjs/ally']
    const patch = allyVersion?.match(/^6\.3\.(\d+)$/)?.[1]
    if (
      state.installedPackages.includes('@adonisjs/ally') &&
      (patch === undefined || Number(patch) < 2)
    )
      diagnostic(
        diagnostics,
        'dependencies.@adonisjs/ally',
        `Installed @adonisjs/ally@${allyVersion || 'unknown'} is outside the verified range >=6.3.2 <6.4.0`
      )
  }
  return missingPackages
}
