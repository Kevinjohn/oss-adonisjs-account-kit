import type { SetupChoices, SetupDiagnostic, SetupInspection } from './types.js'
import { planManagedRoutes, type ManagedRoute } from '../http/routes.js'
import { routePrefix, selectedManagedRoutes, diagnostic } from './shared.js'

/** Route prefix, managed endpoint exclusions and collisions with application routes. */
export function validateRoutes(
  diagnostics: SetupDiagnostic[],
  choices: SetupChoices,
  state: SetupInspection
) {
  if (
    !routePrefix.test(choices.routePrefix) ||
    choices.routePrefix === '/' ||
    choices.routePrefix.endsWith('/') ||
    choices.routePrefix.includes('//')
  )
    diagnostic(
      diagnostics,
      'routePrefix',
      'Use a non-root absolute path without a query or fragment'
    )
  let managedRoutes: ManagedRoute[] = []
  try {
    managedRoutes = selectedManagedRoutes(choices)
    const allowedExcept = planManagedRoutes({
      prefix: choices.routePrefix,
      strategy: choices.authentication?.strategy ?? 'session',
      enabled: choices.managed,
    }).map(({ name }) => name)
    if (
      new Set(choices.managedExcept ?? []).size !== (choices.managedExcept ?? []).length ||
      (choices.managedExcept ?? []).some((name) => !allowedExcept.includes(name))
    )
      diagnostic(
        diagnostics,
        'managedExcept',
        'Exclude each selected managed endpoint at most once'
      )
  } catch {
    diagnostic(
      diagnostics,
      'managedExcept',
      'Select only known endpoint names for the selected strategy and managed groups'
    )
  }
  if (managedRoutes.length) {
    const existing = state.routeDefinitions.flatMap((route) =>
      route.method === 'ANY'
        ? (['GET', 'POST', 'PATCH', 'DELETE'] as const).map((method) => ({ ...route, method }))
        : [route]
    )
    try {
      selectedManagedRoutes(choices, existing)
    } catch (error) {
      diagnostic(
        diagnostics,
        'routePrefix',
        `${(error as Error).message}; exclude the selected endpoint or change the application route`
      )
    }
  }
}
