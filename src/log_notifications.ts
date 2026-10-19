import { createMailNotifications } from './notifications.js'
import type { NotificationCallbacks } from './types.js'

/** Anything with an `info` method, such as the AdonisJS logger. */
export type MessageLogger = { info(message: string): void }

/**
 * Options for `createLogNotifications`, which prints account emails to the log in development and
 * test.
 */
export interface LogNotificationOptions {
  /**
   * Defaults to the AdonisJS logger service, resolved when a message is sent. Config files load
   * before that service exists, so pass a function rather than the service itself.
   */
  logger?: MessageLogger | (() => MessageLogger)
  brandName: string
  /** Refuses production: logged messages contain live action links. */
  environment: 'development' | 'test' | 'production'
}

async function resolveLogger(option: LogNotificationOptions['logger']): Promise<MessageLogger> {
  if (typeof option === 'function') return option()
  if (option) return option
  const { default: logger } = await import('@adonisjs/core/services/logger')
  return logger
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
        const logger = await resolveLogger(options.logger)
        logger.info(
          `[account-kit] mail to ${fields.to}: ${fields.subject}\n${fields.text.trimEnd()}`
        )
      },
    },
  })
}
