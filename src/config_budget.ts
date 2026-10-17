// Validates and defaults one throttle budget option.
import string from '@adonisjs/core/helpers/string'
import type { ThrottleBudget } from './types.js'

export function budget(
  input: Partial<ThrottleBudget> | undefined,
  defaults: ThrottleBudget,
  name: string
): ThrottleBudget {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input)))
    throw new Error(`account_kit: ${name} must be a budget object`)
  const requests = input?.requests ?? defaults.requests
  const duration = input?.duration ?? defaults.duration
  if (!Number.isSafeInteger(requests) || requests <= 0)
    throw new Error(`account_kit: ${name}.requests must be a positive safe integer`)
  let milliseconds: number
  try {
    milliseconds = string.seconds.parse(duration) * 1000
  } catch (cause) {
    throw new Error(`account_kit: ${name}.duration must be a supported positive duration`, {
      cause,
    })
  }
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647)
    throw new Error(`account_kit: ${name}.duration must be a limiter-representable duration`)
  return { requests, duration }
}
