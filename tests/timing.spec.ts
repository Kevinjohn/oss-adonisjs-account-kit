import { test } from '@japa/runner'
import { mock } from 'node:test'
import { performance } from 'node:perf_hooks'
import { waitForFloor } from '../src/timing.js'

test.group('timing floor', () => {
  test('waits until the floor has passed', async ({ assert }) => {
    const started = performance.now()
    await waitForFloor(started, 60)
    assert.isAtLeast(performance.now() - started, 60)
  })

  for (const scenario of ['elapsed', 'zero'] as const) {
    test(`completes without advancing timers when the floor is ${scenario}`, async ({ assert }) => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        const started = performance.now()
        let completed = false
        const waiting = waitForFloor(
          scenario === 'elapsed' ? started - 1000 : started,
          scenario === 'elapsed' ? 60 : 0
        ).then(() => {
          completed = true
        })
        await Promise.resolve()
        assert.isTrue(completed, 'a no-wait branch must complete before any timer advances')
        await waiting
      } finally {
        mock.timers.reset()
      }
    })
  }
})
