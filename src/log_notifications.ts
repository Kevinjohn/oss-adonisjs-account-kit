import type { LogNotificationOptions } from './types_log_notifications.ts'
import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
import { createMailNotifications, type AccountMailService } from './notifications.ts'
import type { NotificationCallbacks } from './types.ts'

/**
 * Development notifications that print each rendered account message, action link included,
 * instead of sending mail. Swap for createMailNotifications once a mail transport is configured.
 *
 * @example
 * ```ts
 * import { createLogNotifications } from '@kevinjohn/adonisjs-account-kit'
 * import logger from '@adonisjs/core/services/logger'
 *
 * const notify = createLogNotifications({ logger: () => logger, brandName: 'Example Studio', environment: 'development' })
 * ```
 */
export function createLogNotifications(options: LogNotificationOptions): NotificationCallbacks {
  if (options.environment === 'production')
    throw new InvalidArgumentsException('account_kit: log notifications are for development only')
  if (!options.logger)
    throw new InvalidArgumentsException('account_kit: log notifications require a logger')
  return createMailNotifications({
    from: 'account-kit@localhost',
    brandName: options.brandName,
    mail: new LogMailService(options),
  })
}

class LogMailService implements AccountMailService {
  #options: LogNotificationOptions

  constructor(options: LogNotificationOptions) {
    this.#options = options
  }

  async sendLater(callback: Parameters<AccountMailService['sendLater']>[0]) {
    const fields = { to: '', subject: '', text: '' }
    const message = {
      to: (value: string) => ((fields.to = value), message),
      from: () => message,
      subject: (value: string) => ((fields.subject = value), message),
      html: () => message,
      text: (value: string) => ((fields.text = value), message),
    }
    callback(message)
    const logger =
      typeof this.#options.logger === 'function' ? this.#options.logger() : this.#options.logger
    logger.info(`[account-kit] mail to ${fields.to}: ${fields.subject}\n${fields.text.trimEnd()}`)
  }
}

export type { MessageLogger, LogNotificationOptions } from './types_log_notifications.ts'
