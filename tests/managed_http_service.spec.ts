import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
import { test } from '@japa/runner'
import { resolveConfig as defineConfig } from '../src/config.ts'
import { ExportFaults } from '../src/account_export.ts'
import { RevocationOutcomes } from '../src/session_revocation.ts'
import { createManagedHttpService } from '../src/managed_http_service.ts'
import { makeConfig } from './helpers/fakes.ts'

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
    exportFaults: new ExportFaults(),
    revocationOutcomes: new RevocationOutcomes(),
  })
  const rejected = service.consume({ endpoint: 'auth.login', clientKey: '' })
  await assert.rejects(
    () => rejected,
    InvalidArgumentsException,
    'Managed request client key is required'
  )
})
