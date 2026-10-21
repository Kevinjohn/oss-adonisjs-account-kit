import { test } from '@japa/runner'
import { createNotify } from '#config/account_kit_notifications'
import { notifications } from '#services/account_kit_notifications'

test.group('Account Kit example notifications', (group) => {
  group.each.setup(() => notifications.reset())

  test('prints proof links in development while keeping the test capture', async ({ assert }) => {
    const messages: string[] = []
    const notify = createNotify((path, token) => `http://localhost:3333/${path}/${token}`, {
      environment: 'development',
      logger: { info: (message) => messages.push(message) },
    })

    await notify.accountActivationProvision?.(
      { email: 'person@example.test', unverifiedEmail: null, hasPassword: true } as never,
      'http://localhost:3333/api/v1/auth/email-verification/example-proof'
    )

    assert.lengthOf(notifications.events, 1)
    assert.equal(notifications.events[0].kind, 'verification')
    assert.include(messages[0], 'person@example.test')
    assert.include(
      messages[0],
      'http://localhost:3333/api/v1/auth/email-verification/example-proof'
    )
  })

  test('never prints proof links outside development', async ({ assert }) => {
    const messages: string[] = []
    const notify = createNotify((path, token) => `http://localhost:3333/${path}/${token}`, {
      environment: 'production',
      logger: { info: (message) => messages.push(message) },
    })

    await notify.accountActivationProvision?.(
      { email: 'person@example.test', unverifiedEmail: null, hasPassword: true } as never,
      'http://localhost:3333/api/v1/auth/email-verification/example-proof'
    )

    assert.lengthOf(notifications.events, 1)
    assert.isEmpty(messages)
  })
})
