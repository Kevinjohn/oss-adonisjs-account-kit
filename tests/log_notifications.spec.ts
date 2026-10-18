import { test } from '@japa/runner'
import { createLogNotifications } from '../src/log_notifications.js'
import { useTestApp } from './helpers/app.js'

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

test.group('createLogNotifications logger resolution', (group) => {
  useTestApp(group)

  test('resolves a logger function when a message is sent', async ({ assert }) => {
    let resolved: { info(message: string): void } | undefined
    const lines: string[] = []
    const notify = createLogNotifications({
      logger: () => resolved!,
      brandName: 'Acme',
      environment: 'development',
    })
    resolved = { info: (message) => lines.push(message) }
    await notify.passwordChanged({ email: 'person@example.test' } as never, {} as never)
    assert.lengthOf(lines, 1)
  })

  test('defaults to the AdonisJS logger service', async ({ assert, cleanup }) => {
    const { default: logger } = await import('@adonisjs/core/services/logger')
    const original = logger.info
    const lines: string[] = []
    logger.info = ((message: string) => lines.push(message)) as typeof logger.info
    cleanup(() => {
      logger.info = original
    })
    const notify = createLogNotifications({ brandName: 'Acme', environment: 'development' })
    await notify.passwordChanged({ email: 'person@example.test' } as never, {} as never)
    assert.match(
      lines[0],
      /^\[account-kit\] mail to person@example\.test: Acme: Your password changed/
    )
  })
})
