import type { SetupChoices, SetupInspection } from './types.js'
import { parseSetupChoices } from './parse.js'
import { managedExclusions } from './shared.js'

export function managedRoutesSource(choices: SetupChoices): string {
  const social =
    choices.social.status === 'enabled' && choices.managed.includes('socialAuthentication')
      ? choices.social
      : null
  return [
    "import router from '@adonisjs/core/services/router'",
    "import app from '@adonisjs/core/services/app'",
    "import { AccountKit } from 'adonisjs-account-kit'",
    "import { registerManagedRoutes } from 'adonisjs-account-kit/http'",
    "import { accountKitGuard } from '#services/account_kit_guard'",
    '',
    'registerManagedRoutes(router, {',
    `  prefix: ${JSON.stringify(choices.routePrefix)},`,
    `  enabled: ${JSON.stringify(choices.managed)},`,
    ...('managedExcept' in choices || managedExclusions(choices).length
      ? [`  except: ${JSON.stringify(managedExclusions(choices))},`]
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

export function disabledManagedRoutesSource(previous: SetupChoices): string {
  return `// Account Kit managed endpoints are disabled by setup.\n// Previous generated selection: ${Buffer.from(JSON.stringify(previous)).toString('base64url')}\n`
}

export function selectedRouteSource(choices: SetupChoices): string {
  return choices.authentication?.applicationRouteRevocation
    ? managedRoutesSource(choices)
    : disabledManagedRoutesSource(choices)
}

export function retainedGeneratedChoices(state: SetupInspection): SetupChoices | null {
  const marker = state.files['start/account_kit_routes.ts']
  const encoded = marker?.match(
    /^\/\/ Account Kit managed endpoints are disabled by setup\.\n\/\/ Previous generated selection: ([A-Za-z0-9_-]+)\n$/
  )?.[1]
  if (!encoded) return null
  try {
    const previous = parseSetupChoices(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    )
    return marker === disabledManagedRoutesSource(previous) ? previous : null
  } catch {
    return null
  }
}
