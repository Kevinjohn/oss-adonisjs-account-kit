// Setup planning phase: prerequisites, migration state, readiness and pillar summary of a plan.
import { migrationNames } from '../../configure.js'
import type {
  SetupChoices,
  SetupFileChange,
  SetupInspection,
  SetupPlan,
  SetupDiagnostic,
} from './types.js'
import { hasEmailFlow } from './shared.js'
import { socialProviderLabels } from '../social_providers.js'

export function planSummary({
  choices,
  state,
  options,
  changes,
  diagnostics,
  endpoints,
  endpointLocations,
  missingPackages,
}: {
  choices: SetupChoices
  state: SetupInspection
  options: { apply?: boolean; retirementImpact?: SetupPlan['retirementImpact'] }
  changes: SetupFileChange[]
  diagnostics: SetupDiagnostic[]
  endpoints: string[]
  endpointLocations: Array<{ name: string; method: string; path: string }>
  missingPackages: string[]
}): SetupPlan {
  const socialChoices = choices.social.status === 'enabled' ? choices.social : null
  const csrfLocation = endpointLocations.find(({ name }) => name === 'auth.csrf')?.path
  const prerequisites = [
    ...missingPackages.map((name) => `Install ${name} explicitly with pnpm add ${name}`),
    'Review generated migrations, then run node ace migration:run explicitly',
    ...(choices.managed.length
      ? ['Verify the generated route mount and existing guard prerequisites']
      : []),
    ...(choices.managed.length && !choices.authentication?.applicationRouteRevocation
      ? [
          'Wire the generated account-access middleware to application-owned protected routes, verify revocation, then rerun setup with applicationRouteRevocation true to activate managed routes',
        ]
      : []),
    ...(choices.managed.length && choices.authentication?.strategy === 'session'
      ? [
          csrfLocation
            ? `Exercise GET ${csrfLocation} and a CSRF-protected POST with the deployed Shield configuration`
            : 'Provide and exercise an application-owned CSRF bootstrap endpoint and a CSRF-protected POST with the deployed Shield configuration',
        ]
      : []),
    ...(socialChoices
      ? socialChoices.providers.map((provider) => {
          const origin = process.env[socialChoices.callbackOriginEnv]
          const path = socialChoices.callbackPath.replace('{provider}', provider)
          let callback = '$' + '{' + socialChoices.callbackOriginEnv + '}' + path
          if (origin) {
            try {
              callback = new URL(path, origin).toString()
            } catch {
              // validateOrigin reports the invalid deployment value.
            }
          }
          return `Register ${provider} callback ${callback} in the provider console and verify its Ally settings`
        })
      : []),
    ...(socialChoices
      ? [
          'Verify D14 first-password reset, password login, and password re-entry for social-only sensitive actions; standard Google and GitHub Ally callbacks cannot establish fresh provider reauthentication proof',
        ]
      : []),
    'Verify model email uniqueness, normalization, hashing and transaction behavior',
  ]
  const hasError = diagnostics.some((item) => item.severity === 'error')
  const hasAction = diagnostics.some((item) => item.severity === 'action')
  return {
    choices,
    preview: options.apply !== true,
    changes,
    diagnostics,
    differences: state.existingChoices ? changedFields(state.existingChoices, choices) : [],
    retirementImpact: options.retirementImpact ?? null,
    prerequisites,
    endpoints: [...new Set(endpoints)],
    endpointLocations,
    migrationState: !state.migrationNames.some((file) => file.includes('_account_kit_'))
      ? 'not-generated'
      : migrationNames.every((name) =>
            state.migrationNames.some((file) => file.endsWith(`_account_kit_${name}.ts`))
          )
        ? 'generated-application-unknown'
        : 'partially-generated',
    readiness: {
      configurationGenerated: changes.every((change) => change.action === 'unchanged'),
      configurationValid: !hasError,
      migrationsApplied: false,
      externalConfigured: !hasError && !hasAction,
      workflowVerified: false,
      productionReady: false,
      delivery: !hasEmailFlow(choices)
        ? 'not applicable'
        : choices.mail.delivery === 'durable'
          ? 'durable'
          : 'best effort',
    },
    pillars: {
      features: `${choices.features.length} services; ${choices.managed.length} managed groups`,
      user: `${choices.user.model} / ${choices.user.table} / ${choices.user.idType}`,
      authentication: choices.authentication
        ? `${choices.authentication.strategy} guard ${choices.authentication.guard}`
        : 'not applicable: no authentication endpoints selected',
      mail: hasEmailFlow(choices)
        ? `${choices.mail.integration}; ${choices.mail.delivery}`
        : 'not applicable: no email capability selected',
      social:
        choices.social.status === 'enabled'
          ? `${choices.social.providers.map((provider) => socialProviderLabels[provider]).join(', ')} selected; stable subject identities; matching email requires linking proof; missing or unverified email requires collection/verification; standard Ally has no fresh provider reauthentication proof; social-only sensitive actions require first-password reset, password login, then password re-entry; ${choices.authentication?.strategy === 'access_tokens' ? 'client POST callback and PKCE token exchange' : 'session callback and server-held PKCE verifier'}`
          : `not applicable: ${choices.social.reason}`,
      policy: `${choices.policy.registration} registration; verification ${choices.policy.verificationRequired ? 'required' : 'optional'}`,
    },
  }
}

export function changedFields(before: unknown, after: unknown, path = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (
    !before ||
    !after ||
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    Array.isArray(before) ||
    Array.isArray(after)
  )
    return [path]
  const oldRecord = before as Record<string, unknown>
  const newRecord = after as Record<string, unknown>
  return [...new Set([...Object.keys(oldRecord), ...Object.keys(newRecord)])].flatMap((key) =>
    changedFields(oldRecord[key], newRecord[key], path ? `${path}.${key}` : key)
  )
}
