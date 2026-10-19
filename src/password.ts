import type { PasswordPolicy } from './types.js'

export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 256

export function isPasswordShaped(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_PASSWORD_LENGTH &&
    value.length <= MAX_PASSWORD_LENGTH
  )
}

function strengthScore(estimatedBits: number): 0 | 1 | 2 | 3 | 4 {
  if (estimatedBits < 28) return 0
  if (estimatedBits < 50) return 1
  if (estimatedBits < 80) return 2
  if (estimatedBits < 110) return 3
  return 4
}

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
  const characterPool =
    Number(lower) * 26 + Number(upper) * 26 + Number(numbers) * 10 + Number(symbols) * 33
  const estimatedBits = value.length * Math.log2(characterPool)
  return strengthScore(estimatedBits) >= policy.minScore
}
