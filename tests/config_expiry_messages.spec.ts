import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { computeConfiguredExpiry } from '../src/config_ttl.ts'
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION, E_ACCOUNT_KIT_INVALID_INPUT } from '../src/errors.ts'

test('invalid expiry names the package configuration and key while retaining its cause', ({
  assert,
}) => {
  let failure: unknown
  try {
    computeConfiguredExpiry('authentication.tokenExpiresIn', DateTime.utc(), 'not-a-duration')
  } catch (error) {
    failure = error
  }
  assert.instanceOf(failure, E_ACCOUNT_KIT_INVALID_CONFIGURATION)
  assert.include((failure as Error).message, 'account_kit')
  assert.include((failure as Error).message, 'authentication.tokenExpiresIn')
  assert.instanceOf((failure as Error).cause, E_ACCOUNT_KIT_INVALID_INPUT)
})
