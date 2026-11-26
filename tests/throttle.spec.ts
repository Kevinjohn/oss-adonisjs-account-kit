import { test } from '@japa/runner'
import { E_ACCOUNT_KIT_THROTTLED } from '../src/errors.ts'
import { consume, buildLimiterKey } from '../src/throttle.ts'
import { useTestApp } from './helpers/app.ts'
test.group('operation throttling', (group) => {
  const kit = useTestApp(group)

  test('separates operations sharing a client key and preserves limiter options', async ({
    assert,
  }) => {
    const options = { requests: 1, duration: '15m' }
    await consume(kit.limiter, 'recovery:client', 'same', options, 'a'.repeat(32), 'default')
    await consume(kit.limiter, 'verification:send', 'same', options, 'a'.repeat(32), 'default')
    assert.deepEqual(options, { requests: 1, duration: '15m' })
    try {
      await consume(kit.limiter, 'recovery:client', 'same', options, 'a'.repeat(32), 'default')
      assert.fail('expected throttle rejection')
    } catch (error) {
      assert.instanceOf(error, E_ACCOUNT_KIT_THROTTLED)
      assert.isAbove((error as InstanceType<typeof E_ACCOUNT_KIT_THROTTLED>).retryAfterSeconds, 0)
      assert.equal(
        (error as InstanceType<typeof E_ACCOUNT_KIT_THROTTLED>).cause &&
          (error as { cause: { code: string } }).cause.code,
        'E_TOO_MANY_REQUESTS'
      )
    }
  })

  test('keeps an exhausted version-1 budget across package renames', async ({ assert }) => {
    const options = { requests: 1, duration: '15m' }
    const storedKey =
      'account-kit:v1:ed4db1e5e8d516de35e9221ee581dec10607da49d81330c734ff710abb9cda8e'
    await kit.limiter.use(options).consume(storedKey)
    try {
      await consume(kit.limiter, 'recovery:client', 'same', options, 'a'.repeat(32), 'default')
      assert.fail('expected the existing budget to remain exhausted')
    } catch (error) {
      assert.instanceOf(error, E_ACCOUNT_KIT_THROTTLED)
    }
    assert.equal(buildLimiterKey('recovery:client', 'same', 'a'.repeat(32), 'default'), storedKey)
  })

  test('propagates unrelated limiter errors unchanged', async ({ assert }) => {
    const failure = Object.assign(new Error('storage unavailable'), {
      code: 'E_TOO_MANY_REQUESTS',
      response: { availableIn: 60 },
    })
    const limiter = {
      use: () => ({
        consume: async () => {
          throw failure
        },
      }),
    }
    try {
      await consume(
        limiter as never,
        'recovery:client',
        'same',
        { requests: 1, duration: '15m' },
        'a'.repeat(32),
        'default'
      )
      assert.fail('expected failure')
    } catch (error) {
      assert.equal(error, failure)
    }
  })
})
