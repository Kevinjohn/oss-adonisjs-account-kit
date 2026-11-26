/** Anything with an `info` method, such as the AdonisJS logger. */
export type MessageLogger = {
  /** Write one informational line. */
  info(message: string): void
}

/**
 * Options for `createLogNotifications`, which prints account emails to the log in development and
 * test.
 */
export interface LogNotificationOptions {
  /**
   * Logger supplied by the application. Config files load
   * before that service exists, so pass a function rather than the service itself.
   */
  logger: MessageLogger | (() => MessageLogger)
  brandName: string
  /** Refuses production: logged messages contain live action links. */
  environment: 'development' | 'test' | 'production'
}
