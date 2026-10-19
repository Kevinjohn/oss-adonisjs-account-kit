import { test } from '@japa/runner'
import { performance } from 'node:perf_hooks'
import { waitForFloor } from '../../src/timing.js'

test.group('timing floor', () => {
  test('waits until the floor has passed', async ({ assert }) => {
    const started = performance.now()
    await waitForFloor(started, 60)
    assert.isAtLeast(performance.now() - started, 60)
  })

  test('returns promptly when the floor has already passed', async ({ assert }) => {
    const before = performance.now()
    await waitForFloor(before - 1000, 60)
    assert.isBelow(performance.now() - before, 30)
  })

  test('returns promptly when the floor is zero', async ({ assert }) => {
    const before = performance.now()
    await waitForFloor(before, 0)
    assert.isBelow(performance.now() - before, 30)
  })
})
