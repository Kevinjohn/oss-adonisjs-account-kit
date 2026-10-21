import app from '@adonisjs/core/services/app'
import { notifications } from '#services/account_kit_notifications'
import type { NotificationCallbacks } from 'adonisjs-account-kit/types'

type NotificationLogger = { info(message: string): void }

export function createNotify(
  accountUrl: (path: string, token: string) => string,
  options: {
    environment?: 'development' | 'test' | 'production'
    logger?: NotificationLogger
  } = {}
): Partial<NotificationCallbacks> {
  const environment = options.environment ?? (app.inDev ? 'development' : 'production')

  async function send(kind: string, recipient: string, value: string) {
    await notifications.send(kind, recipient, value)
    if (environment !== 'development') return

    let logger = options.logger
    if (!logger) {
      const loggerService = await import('@adonisjs/core/services/logger')
      logger = loggerService.default
    }
    logger.info(`[account-kit example] mail to ${recipient}: ${kind}\n${value}`)
  }

  return {
    socialIdentityLinked: (user) => send('socialLinked', user.email, 'Social identity linked'),
    socialIdentityUnlinked: (user) =>
      send('socialUnlinked', user.email, 'Social identity unlinked'),
    passwordResetProvision: (user, url) => send('recovery', user.email, url),
    accountActivationProvision: (user, url) =>
      send(
        'verification',
        user.unverifiedEmail ?? user.email,
        user.hasPassword
          ? url
          : accountUrl('social-verification', new URL(url).pathname.split('/').at(-1)!)
      ),
    invitationProvision: (invitation, url) => send('invitation', invitation.email, url),
    emailChangeProvision: (_user, newEmail, url) => send('emailChangeConfirm', newEmail, url),
    emailChanged: (previousEmail, user) => send('emailChanged', previousEmail, user.email),
    passwordResetCompleted: (user, context) =>
      notifications.deliverCredentialNotice(context.operationId, context.operation, user.email),
    passwordChanged: (user, context) =>
      notifications.deliverCredentialNotice(context.operationId, context.operation, user.email),
  }
}
