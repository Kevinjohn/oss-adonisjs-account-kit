// Setup planning phase: selected package presence and version range diagnostics.
import type { SetupChoices, SetupInspection, SetupDiagnostic } from './types.js'
import { hasEmailFlow, diagnostic } from './shared.js'

type SupportedRange = {
  /** Without a readable installed version the package is skipped unless this says otherwise. */
  unknownVersion?: 'report' | 'reportIfInstalled'
  supports: (version: string) => boolean
  message: (version: string | undefined) => string
}

function caretRange(name: string, minimum: readonly [number, number, number]): SupportedRange {
  return {
    supports: (version) => {
      const parts = version
        .match(/^(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/)
        ?.slice(1)
        .map(Number)
      return Boolean(
        parts &&
        parts[0] === minimum[0] &&
        (parts[1] > minimum[1] || (parts[1] === minimum[1] && parts[2] >= minimum[2]))
      )
    },
    message: (version) =>
      `Installed ${name}@${version} is outside supported ^${minimum.join('.')} range`,
  }
}

const supportedRanges: Record<string, SupportedRange> = {
  'typescript': {
    unknownVersion: 'report',
    supports: (version) => {
      const parts = version
        .match(/^(\d+)\.(\d+)\.(\d+)$/)
        ?.slice(1)
        .map(Number)
      return Boolean(
        parts &&
        ((parts[0] === 5 && (parts[1] > 9 || (parts[1] === 9 && parts[2] >= 3))) ||
          (parts[0] === 6 && (parts[1] > 0 || parts[2] >= 3)))
      )
    },
    message: (version) =>
      `Installed TypeScript version ${version ?? 'unknown'} is outside supported ^5.9.3 || ^6.0.3 range`,
  },
  '@adonisjs/core': caretRange('@adonisjs/core', [7, 0, 0]),
  '@adonisjs/lucid': caretRange('@adonisjs/lucid', [22, 4, 2]),
  '@adonisjs/limiter': caretRange('@adonisjs/limiter', [3, 0, 0]),
  '@adonisjs/auth': caretRange('@adonisjs/auth', [10, 1, 0]),
  '@adonisjs/session': caretRange('@adonisjs/session', [8, 1, 0]),
  '@adonisjs/shield': caretRange('@adonisjs/shield', [9, 0, 0]),
  '@vinejs/vine': caretRange('@vinejs/vine', [4, 4, 0]),
  '@adonisjs/mail': caretRange('@adonisjs/mail', [10, 0, 0]),
  '@adonisjs/ally': {
    unknownVersion: 'reportIfInstalled',
    supports: (version) => {
      const patch = version.match(/^6\.3\.(\d+)$/)?.[1]
      return patch !== undefined && Number(patch) >= 2
    },
    message: (version) =>
      `Installed @adonisjs/ally@${version || 'unknown'} is outside the verified range >=6.3.2 <6.4.0`,
  },
}

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
  for (const name of selectedPackages) {
    const range = supportedRanges[name]
    if (!range) continue
    const version = state.installedVersions[name]
    const reportUnknown =
      range.unknownVersion === 'report' ||
      (range.unknownVersion === 'reportIfInstalled' && state.installedPackages.includes(name))
    if (version ? range.supports(version) : !reportUnknown) continue
    diagnostic(diagnostics, `dependencies.${name}`, range.message(version))
  }
  return missingPackages
}
