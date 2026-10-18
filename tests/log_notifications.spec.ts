import { test } from '@japa/runner'
import { createLogNotifications } from '../src/log_notifications.js'

test.group('createLogNotifications', () => {
  test('logs the rendered message with its action link', async ({ assert }) => {
    const lines: string[] = []
    const notify = createLogNotifications({
      logger: { info: (message) => lines.push(message) },
      brandName: 'Acme',
      environment: 'development',
    })
    await notify.passwordResetProvision(
      { email: 'person@example.test' } as never,
      'http://localhost:3000/reset/token-value'
    )
    assert.lengthOf(lines, 1)
    assert.match(
      lines[0],
      /^\[account-kit\] mail to person@example\.test: Acme: Reset your password\n/
    )
    assert.include(lines[0], 'Reset password: http://localhost:3000/reset/token-value')
  })

  test('refuses production', ({ assert }) => {
    assert.throws(
      () =>
        createLogNotifications({ logger: console, brandName: 'Acme', environment: 'production' }),
      'account_kit: log notifications are for development only'
    )
  })
})
