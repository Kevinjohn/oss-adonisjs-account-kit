// Runtime check for the public UserId domain: a safe integer or a nonempty string.
import type { UserId } from './types.js'

export function isUserId(value: unknown): value is UserId {
  return Number.isSafeInteger(value) || (typeof value === 'string' && value.length > 0)
}
