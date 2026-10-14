import { test } from '@japa/runner'
import { ThrottledError } from '../src/errors.js'
import { consume } from '../src/throttle.js'
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
