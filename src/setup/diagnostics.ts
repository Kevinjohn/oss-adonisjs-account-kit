import type { SetupDiagnostic } from './types.js'

export type SelectedSetupOrigins = {
  values: Record<string, string | null>
  errors: Record<string, string>
}

export const envName = /^[A-Z][A-Z0-9_]*$/

export const sqlName = /^[A-Za-z_][A-Za-z0-9_]*$/

export const routePrefix = /^\/[A-Za-z0-9/_-]*$/

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
  production: boolean,
  env: NodeJS.ProcessEnv = process.env,
  resolvedValue?: string | null,
  resolutionError?: string
) {
  if (!envName.test(variable)) {
    diagnostic(
      diagnostics,
      field,
      'Use an uppercase environment variable name, not a URL or secret'
    )
    return
  }
  if (resolutionError) {
    diagnostic(
      diagnostics,
      field,
      `${variable} could not be inspected safely: ${resolutionError}. Use one direct value assignment.`
    )
    return
  }
  const value = resolvedValue === undefined ? env[variable] : resolvedValue
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
