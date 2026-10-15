export function isPasswordShaped(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 256
}

import type { PasswordPolicy } from './types.js'

export function isPasswordAllowed(value: unknown, policy: PasswordPolicy): value is string {
  if (!isPasswordShaped(value)) return false
  if (
    value.length < policy.minLength ||
    (policy.maxLength !== null && value.length > policy.maxLength)
  )
    return false
  const lower = /[a-z]/.test(value)
  const upper = /[A-Z]/.test(value)
  const numbers = /[0-9]/.test(value)
  const symbols = /[^A-Za-z0-9]/.test(value)
  if (policy.letters && !lower && !upper) return false
  if (policy.mixedCase && (!lower || !upper)) return false
  if (policy.numbers && !numbers) return false
  if (policy.symbols && !symbols) return false
  return Number(lower) + Number(upper) + Number(numbers) + Number(symbols) >= policy.minScore
}
