import { test } from '@japa/runner'
import { ThrottledError } from '../src/errors.js'
import { consume, limiterKey } from '../src/throttle.js'
import { useTestApp } from './helpers/app.js'
test.group('operation throttling', (group) => {
  const kit = useTestApp(group)

  test('separates operations sharing a client key and preserves limiter options', async ({
    assert,
  }) => {
    const options = { requests: 1, duration: '15m' }
    await consume(kit.limiter, 'recovery:client', 'same', options, 'a'.repeat(32))
    await consume(kit.limiter, 'verification:send', 'same', options, 'a'.repeat(32))
    assert.deepEqual(options, { requests: 1, duration: '15m' })
    try {
      await consume(kit.limiter, 'recovery:client', 'same', options, 'a'.repeat(32))
      assert.fail('expected throttle rejection')
    } catch (error) {
      assert.instanceOf(error, ThrottledError)
      assert.isAbove((error as ThrottledError).retryAfterSeconds, 0)
      assert.equal(
        (error as ThrottledError).cause && (error as { cause: { code: string } }).cause.code,
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
      await consume(kit.limiter, 'recovery:client', 'same', options, 'a'.repeat(32))
      assert.fail('expected the existing budget to remain exhausted')
    } catch (error) {
      assert.instanceOf(error, ThrottledError)
    }
    assert.equal(limiterKey('recovery:client', 'same', 'a'.repeat(32)), storedKey)
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
        'a'.repeat(32)
      )
      assert.fail('expected failure')
    } catch (error) {
      assert.equal(error, failure)
    }
  })
})
