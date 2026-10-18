import type { SetupChoices, SetupDiagnostic, SetupFeature } from './types.js'
import { planManagedRoutes, type ExistingRoute, type ManagedRoute } from '../http/routes.js'

export const emailDestinations: Partial<
  Record<SetupFeature, keyof SetupChoices['mail']['destinations']>
> = {
  registration: 'emailVerification',
  emailVerification: 'emailVerification',
  passwordReset: 'passwordReset',
  invitations: 'invitation',
  emailPasswordManagement: 'emailChange',
  magicLinkLogin: 'magicLink',
}

export function hasEmailFlow(choices: SetupChoices): boolean {
  return choices.features.some((feature) => feature in emailDestinations)
}

export const envName = /^[A-Z][A-Z0-9_]*$/

export const sqlName = /^[A-Za-z_][A-Za-z0-9_]*$/

export const routePrefix = /^\/[A-Za-z0-9/_-]*$/

export const nativeMailTransports = new Set([
  'smtp',
  'ses',
  'mailgun',
  'sparkpost',
  'resend',
  'brevo',
  'postmark',
])

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

export function diagnostic(
  diagnostics: SetupDiagnostic[],
  field: string,
  message: string,
  severity: SetupDiagnostic['severity'] = 'error'
) {
  diagnostics.push({ field, message, severity })
}

export function validateOrigin(
  diagnostics: SetupDiagnostic[],
  field: string,
  variable: string,
  production: boolean
) {
  if (!envName.test(variable)) {
    diagnostic(
      diagnostics,
      field,
      'Use an uppercase environment variable name, not a URL or secret'
    )
    return
  }
  const value = process.env[variable]
  if (!value) {
    diagnostic(diagnostics, field, `${variable} must be set before readiness can pass`, 'action')
    return
  }
  try {
    const parsed = new URL(value)
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error('origin must not include credentials, query or fragment')
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('HTTP(S) is required')
    if (production && parsed.protocol !== 'https:') {
      diagnostic(diagnostics, field, `${variable} must use HTTPS in production`)
    } else if (
      parsed.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    ) {
      diagnostic(diagnostics, field, `${variable} may use HTTP only for loopback development`)
    }
  } catch {
    diagnostic(diagnostics, field, `${variable} must be a valid trusted HTTP(S) origin`)
  }
}
