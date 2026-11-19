import type { SetupDiagnostic } from './types.js'

/** Selected environment values read from the process or the application's `.env` files. */
export type SelectedSetupOrigins = {
  values: Record<string, string | null>
  errors: Record<string, { message: string; indirect: boolean }>
}

export const envName = /^[A-Z][A-Z0-9_]*$/

export const sqlName = /^[A-Za-z_][A-Za-z0-9_]*$/

export const routePrefix = /^\/[A-Za-z0-9/_-]*$/

export function addSetupDiagnostic(
  diagnostics: SetupDiagnostic[],
  field: string,
  message: string,
  severity: SetupDiagnostic['severity'] = 'error'
) {
  diagnostics.push({ field, message, severity })
}

export function addOriginDiagnostics(
  diagnostics: SetupDiagnostic[],
  field: string,
  variable: string,
  production: boolean,
  env: NodeJS.ProcessEnv = process.env,
  resolvedValue?: string | null,
  resolutionError?: { message: string; indirect: boolean }
) {
  if (!envName.test(variable)) {
    addSetupDiagnostic(
      diagnostics,
      field,
      'Use an uppercase environment variable name, not a URL or secret'
    )
    return
  }
  if (resolutionError?.indirect) {
    addSetupDiagnostic(
      diagnostics,
      field,
      `${variable} refers to other values, so setup cannot check it before the application starts. Confirm it resolves to a trusted HTTP(S) origin.`,
      'action'
    )
    return
  }
  if (resolutionError) {
    addSetupDiagnostic(
      diagnostics,
      field,
      `${variable} could not be inspected safely: ${resolutionError.message}. Use one direct value assignment.`
    )
    return
  }
  const value = resolvedValue === undefined ? env[variable] : resolvedValue
  if (!value) {
    addSetupDiagnostic(
      diagnostics,
      field,
      `${variable} must be set before readiness can pass`,
      'action'
    )
    return
  }
  try {
    const parsed = new URL(value)
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error('origin must not include credentials, query or fragment')
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('HTTP(S) is required')
    if (production && parsed.protocol !== 'https:') {
      addSetupDiagnostic(diagnostics, field, `${variable} must use HTTPS in production`)
    } else if (
      parsed.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    ) {
      addSetupDiagnostic(
        diagnostics,
        field,
        `${variable} may use HTTP only for loopback development`
      )
    }
  } catch {
    addSetupDiagnostic(diagnostics, field, `${variable} must be a valid trusted HTTP(S) origin`)
  }
}
