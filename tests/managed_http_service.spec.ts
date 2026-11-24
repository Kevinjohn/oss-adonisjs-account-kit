import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
import { test } from '@japa/runner'
import { defineConfig } from '../src/config.js'
import { createManagedHttpService } from '../src/managed_http_service.js'
import { makeConfig } from './helpers/fakes.js'

test('rejects an empty managed request key before using the throttle', async ({ assert }) => {
  const service = createManagedHttpService({
    config: defineConfig(makeConfig({})),
    throttler: {
      async consume() {
        throw new Error('throttle used')
      },
      deriveKey() {
        throw new Error('throttle key derived')
      },
    },
  })
  const rejected = service.consume({ endpoint: 'auth.login', clientKey: '' })
  await assert.rejects(
    () => rejected,
    InvalidArgumentsException,
    'Managed request client key is required'
  )
})
