import type { HttpContext } from '@adonisjs/core/http'
import kit from '@kevinjohn/adonisjs-account-kit/services/main'

/** Protect application-owned bearer-proof responses, including redirects and errors. */
export function sendTokenPageHeaders(response: HttpContext['response']) {
  response.header('Cache-Control', 'no-store')
  response.header('Referrer-Policy', 'no-referrer')
}

/** Match only the three application-owned proof routes, before routing or body parsing. */
export function proofRequest(request: HttpContext['request']) {
  if (!['GET', 'POST'].includes(request.method())) return null
  const match = /^\/(reset-password|verify-email|confirm-email)\/([^/]+)\/?$/.exec(request.url())
  if (!match) return null
  const family = match[1]
  const fallback = family === 'reset-password' ? '/forgot-password' : '/login'
  let token: string
  try {
    token = decodeURIComponent(match[2])
  } catch {
    return { family, fallback, token: null, path: null }
  }
  const shaped =
    /^[A-Za-z0-9_-]{22,86}$/.test(token) &&
    Buffer.from(token, 'base64url').toString('base64url') === token
  return {
    family,
    fallback,
    token: shaped ? token : null,
    path: shaped ? `/${family}/${encodeURIComponent(token)}` : null,
  }
}

/** Only an existing proof may retain its bearer URL during correctable form recovery. */
export async function proofRecovery(request: HttpContext['request']) {
  const proof = proofRequest(request)
  if (!proof) return null
  if (!proof.token || !proof.path) return proof.fallback
  const input = { token: proof.token }
  const valid =
    proof.family === 'reset-password'
      ? await kit.passwordReset.inspect(input)
      : proof.family === 'verify-email'
        ? await kit.emailVerification.inspect(input)
        : await kit.emailPasswordManagement.inspectEmailChange(input)
  return valid ? proof.path : proof.fallback
}
