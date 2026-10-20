// Validates and defaults one throttle budget option.
import { RuntimeException } from '@adonisjs/core/exceptions'
import string from '@adonisjs/core/helpers/string'
import { assertPlainObject } from './config_assert.js'
import type { ThrottleBudget } from './types.js'

export function budget(
  input: Partial<ThrottleBudget> | undefined,
  defaults: ThrottleBudget,
  name: string
): ThrottleBudget {
  if (input !== undefined) assertPlainObject(input, name)
  const requests = input?.requests ?? defaults.requests
  const duration = input?.duration ?? defaults.duration
  if (!Number.isSafeInteger(requests) || requests <= 0)
    throw new RuntimeException(`account_kit: ${name}.requests must be a positive safe integer`)
  let milliseconds: number
  try {
    milliseconds = string.seconds.parse(duration) * 1000
  } catch (cause) {
    throw new RuntimeException(
      `account_kit: ${name}.duration must be a supported positive duration`,
      {
        cause,
      }
    )
  }
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647)
    throw new RuntimeException(
      `account_kit: ${name}.duration must be a limiter-representable duration`
    )
  return { requests, duration }
}
