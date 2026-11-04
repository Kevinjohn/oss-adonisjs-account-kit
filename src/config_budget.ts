// Validates and defaults one throttle budget option.
import string from '@adonisjs/core/helpers/string'
import { assertObject } from './config_assert.js'
import { InvalidConfigurationError } from './errors.js'
import type { ThrottleBudget } from './types.js'
import { freezeResolved } from './config_freeze.js'

export function budget(
  input: Partial<ThrottleBudget> | undefined,
  defaults: ThrottleBudget,
  name: string,
  durationField = `${name}.duration`
): ThrottleBudget {
  if (input !== undefined) assertObject(input, name)
  const requests = input?.requests ?? defaults.requests
  const duration = input?.duration ?? defaults.duration
  if (!Number.isSafeInteger(requests) || requests <= 0)
    throw new InvalidConfigurationError(
      `${name}.requests`,
      `account_kit: ${name}.requests must be a positive safe integer`
    )
  let milliseconds: number
  try {
    milliseconds = string.seconds.parse(duration) * 1000
  } catch (cause) {
    throw new InvalidConfigurationError(
      durationField,
      `account_kit: ${durationField} must be a supported positive duration`,
      { cause }
    )
  }
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647)
    throw new InvalidConfigurationError(
      durationField,
      `account_kit: ${durationField} must be a limiter-representable duration`
    )
  return freezeResolved({ requests, duration })
}
