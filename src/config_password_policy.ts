// Validates and defaults the passwordPolicy option.
import type { AccountKitConfig, PasswordPolicy } from './types.js'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password.js'

export function resolvePasswordPolicy(
  config: Pick<AccountKitConfig, 'passwordPolicy'>
): PasswordPolicy {
  const passwordPolicy = {
    minLength: config.passwordPolicy?.minLength ?? 8,
    maxLength: config.passwordPolicy?.maxLength ?? null,
    letters: config.passwordPolicy?.letters ?? false,
    mixedCase: config.passwordPolicy?.mixedCase ?? false,
    numbers: config.passwordPolicy?.numbers ?? false,
    symbols: config.passwordPolicy?.symbols ?? false,
    minScore: config.passwordPolicy?.minScore ?? 0,
  }
  if (
    config.passwordPolicy !== undefined &&
    (!config.passwordPolicy ||
      typeof config.passwordPolicy !== 'object' ||
      Array.isArray(config.passwordPolicy))
  )
    throw new Error('account_kit: passwordPolicy must be an object')
  if (
    !Number.isSafeInteger(passwordPolicy.minLength) ||
    passwordPolicy.minLength < MIN_PASSWORD_LENGTH ||
    passwordPolicy.minLength > MAX_PASSWORD_LENGTH ||
    (passwordPolicy.maxLength !== null &&
      (!Number.isSafeInteger(passwordPolicy.maxLength) ||
        passwordPolicy.maxLength > MAX_PASSWORD_LENGTH ||
        passwordPolicy.maxLength < passwordPolicy.minLength))
  )
    throw new Error(
      `account_kit: passwordPolicy lengths must stay within ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} and minLength must not exceed maxLength`
    )
  if (
    !Number.isSafeInteger(passwordPolicy.minScore) ||
    passwordPolicy.minScore < 0 ||
    passwordPolicy.minScore > 4
  )
    throw new Error('account_kit: passwordPolicy.minScore must be an integer from 0 to 4')
  for (const key of ['letters', 'mixedCase', 'numbers', 'symbols'] as const)
    if (typeof passwordPolicy[key] !== 'boolean')
      throw new Error(`account_kit: passwordPolicy.${key} must be boolean`)
  return passwordPolicy
}
