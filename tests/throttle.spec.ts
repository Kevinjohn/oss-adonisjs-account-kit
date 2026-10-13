import { test } from '@japa/runner'
import { ThrottledError } from '../src/errors.js'
import { consume } from '../src/throttle.js'
import { bootTestApp } from './helpers/app.js'
import { resetSchema } from './helpers/schema.js'

test.group('operation throttling', (group) => {
  let kit: Awaited<ReturnType<typeof bootTestApp>>
  group.setup(async () => {
    kit = await bootTestApp()
  })
  group.each.setup(async () => {
    await resetSchema(kit)
    await kit.limiter.clear()
  })
  group.teardown(async () => {
    await kit.close()
  })

  test('separates operations sharing a client key and preserves limiter options', async ({
    assert,
  }) => {
    const options = { requests: 1, duration: '15m' }
    await consume(kit.limiter, 'recovery:client', 'same', options)
    await consume(kit.limiter, 'verification:send', 'same', options)
    assert.deepEqual(options, { requests: 1, duration: '15m' })
    try {
      await consume(kit.limiter, 'recovery:client', 'same', options)
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
      await consume(limiter as never, 'recovery:client', 'same', { requests: 1, duration: '15m' })
      assert.fail('expected failure')
    } catch (error) {
      assert.equal(error, failure)
    }
  })
})
