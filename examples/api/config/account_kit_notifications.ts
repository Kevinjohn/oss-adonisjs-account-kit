import { notifications } from '#services/account_kit_notifications'
import type { NotificationCallbacks } from 'adonisjs-account-kit/types'

export function createNotify(
  accountUrl: (path: string, token: string) => string
): Partial<NotificationCallbacks> {
  return {
    socialIdentityLinked: async (user) => {
      await notifications.send('socialLinked', user.email, 'Social identity linked')
    },
    socialIdentityUnlinked: async (user) => {
      await notifications.send('socialUnlinked', user.email, 'Social identity unlinked')
    },
    passwordResetProvision: (user, url) => notifications.send('recovery', user.email, url),
    accountActivationProvision: (user, url) =>
      notifications.send(
        'verification',
        user.unverifiedEmail ?? user.email,
        user.hasPassword
          ? url
          : accountUrl('social-verification', new URL(url).pathname.split('/').at(-1)!)
      ),
    invitationProvision: (invitation, url) =>
      notifications.send('invitation', invitation.email, url),
    emailChangeProvision: (_user, newEmail, url) =>
      notifications.send('emailChangeConfirm', newEmail, url),
    emailChanged: (previousEmail, user) =>
      notifications.send('emailChanged', previousEmail, user.email),
    passwordResetCompleted: (user, context) =>
      notifications.deliverCredentialNotice(context.operationId, context.operation, user.email),
    passwordChanged: (user, context) =>
      notifications.deliverCredentialNotice(context.operationId, context.operation, user.email),
  }
}
