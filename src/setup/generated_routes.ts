import type { SetupChoices, SetupInspection } from './types.ts'
import { requireSetupChoices } from './parse.ts'
import { listManagedExclusions } from './shared.ts'

export function generateManagedRoutesSource(choices: SetupChoices): string {
  const social =
    choices.social.status === 'enabled' && choices.managed.includes('socialAuthentication')
      ? choices.social
      : null
  return [
    "import router from '@adonisjs/core/services/router'",
    "import app from '@adonisjs/core/services/app'",
    "import { AccountKit } from '@kevinjohn/adonisjs-account-kit'",
    "import { accountKitGuard } from '#services/account_kit_guard'",
    '',
    "const managedRoutes = await app.container.make('account_kit.managed_routes')",
    '',
    'managedRoutes.register(router, {',
    `  prefix: ${JSON.stringify(choices.routePrefix)},`,
    `  enabled: ${JSON.stringify(choices.managed)},`,
    ...('managedExcept' in choices || listManagedExclusions(choices).length
      ? [`  except: ${JSON.stringify(listManagedExclusions(choices))},`]
      : []),
    `  verificationRequired: ${choices.policy.verificationRequired},`,
    '  kit: () => app.container.make(AccountKit),',
    '  guard: accountKitGuard,',
    ...(social
      ? [`  extensions: { social: { providers: ${JSON.stringify(social.providers)} } },`]
      : []),
    '})',
    '',
  ].join('\n')
}

export function generateDisabledRoutesSource(previous: SetupChoices): string {
  return `// Account Kit managed endpoints are disabled by setup.\n// Previous generated selection: ${Buffer.from(JSON.stringify(previous)).toString('base64url')}\n`
}

export function resolveRouteSource(choices: SetupChoices): string {
  return choices.authentication?.applicationRouteRevocation
    ? generateManagedRoutesSource(choices)
    : generateDisabledRoutesSource(choices)
}

export function readRetainedSetupChoices(state: SetupInspection): SetupChoices | null {
  const marker = state.files['start/account_kit_routes.ts']
  const encoded = marker?.match(
    /^\/\/ Account Kit managed endpoints are disabled by setup\.\n\/\/ Previous generated selection: ([A-Za-z0-9_-]+)\n$/
  )?.[1]
  if (!encoded) return null
  try {
    // Compare the decoded selection itself: a marker from an earlier version may list fields
    // that parsing now drops, and re-encoding the parsed copy would no longer match it.
    const previous = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SetupChoices
    requireSetupChoices(previous)
    return marker === generateDisabledRoutesSource(previous) ? previous : null
  } catch {
    return null
  }
}
