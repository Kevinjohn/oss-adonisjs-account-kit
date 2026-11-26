import type { HttpContext } from '@adonisjs/core/http'

export function buildProofHeaders(): Record<string, string> {
  return { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
}

export function applyProofHeaders(response: HttpContext['response']): void {
  for (const [name, value] of Object.entries(buildProofHeaders())) response.header(name, value)
}
