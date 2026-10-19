import { test } from '@japa/runner'
import { DeliveryError, PostCommitError } from '../src/errors.js'
import { afterCommit, lifecycle, postCommit } from '../src/effects.js'
import type { LifecycleEvent } from '../src/types.js'

test.group('post-commit effects', () => {
  test('attempts every delivery and reports delivery-only failure', async ({ assert }) => {
    const events: string[] = []
    const first = new Error('first')
    const second = new Error('second')
    let failure: unknown
    try {
      await postCommit('delivery failed', [
        {
          kind: 'delivery',
          run: async () => {
            events.push('one')
            throw first
          },
        },
        {
          kind: 'delivery',
          run: async () => {
            events.push('two')
            throw second
          },
        },
      ])
    } catch (error) {
      failure = error
    }
    assert.instanceOf(failure, DeliveryError)
    assert.deepEqual(events, ['one', 'two'])
    assert.deepEqual(
      (failure as DeliveryError).cause instanceof AggregateError
        ? ((failure as DeliveryError).cause as AggregateError).errors
        : [],
      [first, second]
    )
  })

  test('an observer failure makes mixed follow-ups a committed-change error', async ({
    assert,
  }) => {
    const delivery = new Error('delivery')
    const observer = new Error('observer')
    let failure: unknown
    try {
      await postCommit('follow-up failed', [
        {
          kind: 'delivery',
          run: async () => {
            throw delivery
          },
        },
        {
          kind: 'observer',
          run: async () => {
            throw observer
          },
        },
      ])
    } catch (error) {
      failure = error
    }
    assert.instanceOf(failure, PostCommitError)
    assert.deepEqual(
      (failure as PostCommitError).cause instanceof AggregateError
        ? ((failure as PostCommitError).cause as AggregateError).errors
        : [],
      [delivery, observer]
    )
  })

  test('lifecycle wraps the event hook as an observer effect run at follow-up time', async ({
    assert,
  }) => {
    const seen: LifecycleEvent[] = []
    const event: LifecycleEvent = { type: 'password.changed', userId: 1, operationId: 'op' }
    const effect = lifecycle({ onLifecycleEvent: async (value) => void seen.push(value) }, event)
    assert.equal(effect.kind, 'observer')
    assert.deepEqual(seen, [])
    await effect.run()
    assert.deepEqual(seen, [event])
    assert.isUndefined(await lifecycle({}, event).run())
    const listener = new Error('listener')
    let failure: unknown
    try {
      await postCommit('follow-up failed', [
        lifecycle(
          {
            onLifecycleEvent: async () => {
              throw listener
            },
          },
          event
        ),
      ])
    } catch (error) {
      failure = error
    }
    assert.instanceOf(failure, PostCommitError)
    assert.equal((failure as PostCommitError).cause, listener)
  })

  test('afterCommit reports a failing notice as PostCommitError and still runs later effects', async ({
    assert,
  }) => {
    const notice = new Error('notice')
    const ran: string[] = []
    let failure: unknown
    try {
      await afterCommit(
        'follow-up failed',
        async () => {
          ran.push('notice')
          throw notice
        },
        async () => {
          ran.push('event')
        }
      )
    } catch (error) {
      failure = error
    }
    assert.deepEqual(ran, ['notice', 'event'])
    assert.instanceOf(failure, PostCommitError)
    assert.notInstanceOf(failure, DeliveryError)
    assert.equal((failure as PostCommitError).cause, notice)
  })
})
