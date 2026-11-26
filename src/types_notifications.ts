import type { Capability, NotificationCallbacks, UrlCallbacks } from './types_foundation.ts'
import type { AccountKitTranslator } from './translator.ts'

/**
 * Options for `createActionUrls`: the backend and frontend origins, the relative path of each page,
 * and the environment. Production origins must be HTTPS.
 */
export interface ActionUrlOptions {
  /** The API's public origin. */
  backendOrigin: string
  /** The name of the backend origin setting to show in configuration diagnostics. */
  backendOriginSetting?: string
  /** The frontend URL the links point at, including any base path. */
  appFrontendUrl: string
  /**
   * The relative page path for each kind of link, such as `reset-password`. The token is appended.
   */
  destinations: Partial<Record<keyof UrlCallbacks, string>>
  /** In production, origins must be HTTPS; HTTP is allowed only for loopback in development. */
  environment: 'development' | 'test' | 'production'
}

export type AccountMessageKind = keyof NotificationCallbacks

/** A rendered account email: subject, plain text and HTML. */
export interface RenderedAccountMessage {
  subject: string
  text: string
  html: string
}

/** The small Mail surface used here keeps service-only imports independent of @adonisjs/mail. */
export interface AccountMailService {
  /** Queue a message; `callback` fills it in. */
  sendLater(callback: (message: AccountMailMessage) => void): Promise<unknown>
}

/** The part of an AdonisJS Mail message `createMailNotifications` uses. */
export interface AccountMailMessage {
  /** Set the recipient address. */
  to(address: string): this
  /** Set the sender address. */
  from(address: string): this
  /** Set the subject line. */
  subject(subject: string): this
  /** Set the HTML body. */
  html(content: string): this
  /** Set the plain-text body. */
  text(content: string): this
}

/** Options for `createMailNotifications`. */
export interface MailNotificationOptions {
  /**
   * Defaults to the AdonisJS Mail service, resolved when a message is sent. Config files load
   * before that service exists, so pass a function rather than the service itself.
   */
  mail?: AccountMailService | (() => AccountMailService)
  /** The sender address. */
  from: string
  /** Your product name, used in subjects and message bodies. */
  brandName: string
  /** Receives escaped body markup; return a complete HTML document or wrapper. */
  emailLayout?: (body: string) => string
  /**
   * An `@adonisjs/i18n` instance for one site-wide language, resolved when a message is sent, for
   * example `() => i18nManager.locale('fr')`. Each part is looked up as
   * `account_kit.emails.<kind>.<part>`, with the English text as the fallback.
   */
  i18n?: AccountKitTranslator | (() => AccountKitTranslator)
}

/**
 * What `notificationReadiness` checks: environment, delivery mode, mail transport, origins, enabled
 * capabilities and page paths.
 */
export interface NotificationReadinessInput {
  /** The environment being checked. */
  environment: ActionUrlOptions['environment']
  /** The configured `delivery` mode. */
  delivery: 'best-effort' | 'durable' | 'capture'
  /** The application's selected AdonisJS Mail transport behavior. */
  transport: 'delivery' | 'capture' | 'discard'
  /** The API's public origin. */
  backendOrigin: string
  /** The frontend origin the links point at. */
  actionOrigin: string
  /** The enabled capabilities, to know which links are needed. */
  enabled: Capability[]
  /** The relative page path for each kind of link. */
  destinations: Partial<Record<keyof UrlCallbacks, string>>
  /** Application assertions; Account Kit cannot inspect an application-owned worker. */
  durableChecks?: {
    worker: boolean
    retries: boolean
    terminalFailures: boolean
    actionLinks: boolean
    securityNotices: boolean
  }
}
