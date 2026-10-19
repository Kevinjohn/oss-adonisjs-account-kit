import type { SetupChoices } from './types.js'
import { planManagedRoutes, type ExistingRoute, type ManagedRoute } from '../http/routes.js'

export function managedExclusions(choices: SetupChoices): ManagedRoute['name'][] {
  return [
    ...new Set([
      ...(choices.managedExcept ?? []),
      ...(choices.social.status === 'enabled' &&
      choices.managed.includes('socialAuthentication') &&
      choices.policy.registration === 'application'
        ? (['auth.oauth.registration'] as const)
        : []),
    ]),
  ]
}

export function selectedManagedRoutes(
  choices: SetupChoices,
  existing: readonly ExistingRoute[] = []
): ManagedRoute[] {
  if (!choices.managed.length || !choices.authentication) return []
  return planManagedRoutes(
    {
      prefix: choices.routePrefix,
      strategy: choices.authentication.strategy,
      enabled: choices.managed,
      except: managedExclusions(choices),
    },
    existing
  )
}
