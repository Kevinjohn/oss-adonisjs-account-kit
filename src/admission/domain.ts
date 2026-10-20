// Email domain rules: which domains configuration accepts and whether an address matches one.
import { isEmailShaped } from '../email.js'

const label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * A lowercase ASCII domain of at least two labels, each at most 63 characters, at most 253 in all.
 * Rejects wildcards, `@`, leading or trailing dots and anything non-ASCII.
 */
export function isDomainName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false
  const labels = value.split('.')
  return labels.length >= 2 && labels.every((part) => part.length <= 63 && label.test(part))
}

/**
 * The part after the `@` of a well-formed address, or null. No IDN conversion: a Unicode domain is
 * returned as stored and never matches an allowed entry.
 */
export function domainOf(email: string): string | null {
  if (!isEmailShaped(email)) return null
  return email.slice(email.indexOf('@') + 1)
}

/** Whether `domain` equals an allowed entry or, with `includeSubdomains`, is under one. */
export function domainAllowed(
  domain: string,
  rule: { allowed: readonly string[]; includeSubdomains: boolean }
): boolean {
  if (!isDomainName(domain)) return false
  return rule.allowed.some(
    (entry) => domain === entry || (rule.includeSubdomains && domain.endsWith('.' + entry))
  )
}
