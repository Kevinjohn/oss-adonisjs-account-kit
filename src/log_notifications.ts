import { createMailNotifications } from './notifications.js'
import type { NotificationCallbacks } from './types.js'

export interface LogNotificationOptions {
  logger: { info(message: string): void }
  brandName: string
  /** Refuses production: logged messages contain live action links. */
  environment: 'development' | 'test' | 'production'
}

/**
 * Development notifications that print each rendered account message, action link included,
 * instead of sending mail. Swap for createMailNotifications once a mail transport is configured.
 */
export function createLogNotifications(options: LogNotificationOptions): NotificationCallbacks {
  if (options.environment === 'production')
    throw new Error('account_kit: log notifications are for development only')
  return createMailNotifications({
    from: 'account-kit@localhost',
    brandName: options.brandName,
    mail: {
      async sendLater(callback) {
        const fields = { to: '', subject: '', text: '' }
        const message = {
          to: (value: string) => ((fields.to = value), message),
          from: () => message,
          subject: (value: string) => ((fields.subject = value), message),
          html: () => message,
          text: (value: string) => ((fields.text = value), message),
        }
        callback(message)
        options.logger.info(
          `[account-kit] mail to ${fields.to}: ${fields.subject}\n${fields.text.trimEnd()}`
        )
      },
    },
  })
}
