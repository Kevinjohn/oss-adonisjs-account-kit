import { test } from '@japa/runner'
import { E_ACCOUNT_KIT_DELIVERY, E_ACCOUNT_KIT_POST_COMMIT } from '../src/errors.ts'
import { createLifecycleEffect, postCommit } from '../src/effects.ts'
import type { LifecycleEvent } from '../src/types.ts'

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
    assert.instanceOf(failure, E_ACCOUNT_KIT_DELIVERY)
    assert.deepEqual(events, ['one', 'two'])
    assert.deepEqual((failure as InstanceType<typeof E_ACCOUNT_KIT_DELIVERY>).cause, [
      first,
      second,
    ])
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
    assert.instanceOf(failure, E_ACCOUNT_KIT_POST_COMMIT)
    assert.deepEqual((failure as InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT>).cause, [
      delivery,
      observer,
    ])
  })

  test('lifecycle wraps the event hook as an observer effect run at follow-up time', async ({
    assert,
  }) => {
    const seen: LifecycleEvent[] = []
    const event: LifecycleEvent = { type: 'password.changed', userId: 1, operationId: 'op' }
    const effect = createLifecycleEffect(
      { onLifecycleEvent: async (value) => void seen.push(value) },
      event
    )
    assert.equal(effect.kind, 'observer')
    assert.deepEqual(seen, [])
    await effect.run()
    assert.deepEqual(seen, [event])
    assert.isUndefined(await createLifecycleEffect({}, event).run())
    const listener = new Error('listener')
    let failure: unknown
    try {
      await postCommit('follow-up failed', [
        createLifecycleEffect(
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
    assert.instanceOf(failure, E_ACCOUNT_KIT_POST_COMMIT)
    assert.equal((failure as InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT>).cause, listener)
  })

  test('a delivery failure reports E_ACCOUNT_KIT_DELIVERY and still runs later effects', async ({
    assert,
  }) => {
    const notice = new Error('notice')
    const ran: string[] = []
    let failure: unknown
    try {
      await postCommit('follow-up failed', [
        {
          kind: 'delivery',
          run: async () => {
            ran.push('notice')
            throw notice
          },
        },
        {
          kind: 'observer',
          run: async () => {
            ran.push('event')
          },
        },
      ])
    } catch (error) {
      failure = error
    }
    assert.deepEqual(ran, ['notice', 'event'])
    assert.instanceOf(failure, E_ACCOUNT_KIT_DELIVERY)
    assert.equal((failure as InstanceType<typeof E_ACCOUNT_KIT_DELIVERY>).cause, notice)
  })
})
