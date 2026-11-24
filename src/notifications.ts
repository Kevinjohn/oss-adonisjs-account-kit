import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
import type { NotificationCallbacks } from './types.js'
import type { AccountKitTranslator } from './translator.js'
import { isSocialProviderName, socialProviderLabels } from './social_providers.js'
import { renderAccountMessage, type AccountMessageKind } from './account_message_templates.js'

export {
  renderAccountMessage,
  type AccountMessageKind,
  type RenderedAccountMessage,
} from './account_message_templates.js'

export { createActionUrls, type ActionUrlOptions } from './action_urls.js'
export { notificationReadiness, type NotificationReadinessInput } from './notification_readiness.js'

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
 * Maintained action-link values; pass their rendered content through createMailNotifications.
 *
 * @example
 * ```ts
 * import { PasswordResetProvision } from '@kevinjohn/adonisjs-account-kit'
 *
 * const provision = new PasswordResetProvision(
 *   'sam@example.test',
 *   'https://app.example.test/reset-password/example-token'
 * )
 * ```
 */
export class PasswordResetProvision {
  readonly kind = 'passwordResetProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}
/**
 * An account activation email to send: recipient and action URL.
 *
 * @example
 * ```ts
 * import { AccountActivationProvision } from '@kevinjohn/adonisjs-account-kit'
 *
 * const provision = new AccountActivationProvision(
 *   'sam@example.test',
 *   'https://app.example.test/activate/example-token'
 * )
 * ```
 */
export class AccountActivationProvision {
  readonly kind = 'accountActivationProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}
/**
 * An invitation email to send: recipient and action URL.
 *
 * @example
 * ```ts
 * import { InvitationProvision } from '@kevinjohn/adonisjs-account-kit'
 *
 * const provision = new InvitationProvision(
 *   'sam@example.test',
 *   'https://app.example.test/accept-invitation/example-token'
 * )
 * ```
 */
export class InvitationProvision {
  readonly kind = 'invitationProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}
/**
 * An email-change confirmation to send: recipient and action URL.
 *
 * @example
 * ```ts
 * import { EmailChangeProvision } from '@kevinjohn/adonisjs-account-kit'
 *
 * const provision = new EmailChangeProvision(
 *   'sam@example.test',
 *   'https://app.example.test/confirm-email/example-token'
 * )
 * ```
 */
export class EmailChangeProvision {
  readonly kind = 'emailChangeProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}

/**
 * A magic sign-in link email to send: recipient and action URL.
 *
 * @example
 * ```ts
 * import { MagicLinkProvision } from '@kevinjohn/adonisjs-account-kit'
 *
 * const provision = new MagicLinkProvision(
 *   'sam@example.test',
 *   'https://app.example.test/sign-in/example-token'
 * )
 * ```
 */
export class MagicLinkProvision {
  readonly kind = 'magicLinkProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}

function resolveTranslator(
  option: MailNotificationOptions['i18n']
): AccountKitTranslator | undefined {
  return typeof option === 'function' ? option() : option
}

async function resolveMail(option: MailNotificationOptions['mail']): Promise<AccountMailService> {
  if (typeof option === 'function') return option()
  if (option) return option
  const { default: mail } = await import('@adonisjs/mail/services/main')
  return mail
}

/**
 * Implements every notification callback with AdonisJS Mail and the built-in templates.
 * Messages are queued with `sendLater`.
 *
 * @example
 * ```ts
 * import { createMailNotifications } from '@kevinjohn/adonisjs-account-kit'
 *
 * const notify = createMailNotifications({
 *   from: 'accounts@example.test',
 *   brandName: 'Example Studio',
 * })
 * ```
 */
export function createMailNotifications(options: MailNotificationOptions): NotificationCallbacks {
  if (
    !options.from?.trim() ||
    !options.brandName?.trim() ||
    /[\r\n]/.test(options.from) ||
    /[\r\n]/.test(options.brandName)
  )
    throw new InvalidArgumentsException('account_kit: from and brandName are required')
  async function send(
    kind: AccountMessageKind,
    recipient: string,
    actionUrl?: string,
    providerName?: string
  ) {
    const rendered = renderAccountMessage(
      kind,
      { brandName: options.brandName, actionUrl, providerName },
      options.emailLayout,
      { i18n: resolveTranslator(options.i18n) }
    )
    const mail = await resolveMail(options.mail)
    await mail.sendLater((message) => {
      message
        .to(recipient)
        .from(options.from)
        .subject(rendered.subject)
        .html(rendered.html)
        .text(rendered.text)
    })
  }
  return {
    passwordResetProvision: (user, url) => {
      const message = new PasswordResetProvision(user.email, url)
      return send(message.kind, message.recipient, message.actionUrl)
    },
    accountActivationProvision: (user, url) => {
      const message = new AccountActivationProvision(user.unverifiedEmail ?? user.email, url)
      return send(message.kind, message.recipient, message.actionUrl)
    },
    invitationProvision: (invitation, url) => {
      const message = new InvitationProvision(invitation.email, url)
      return send(message.kind, message.recipient, message.actionUrl)
    },
    emailChangeProvision: (_user, newEmail, url) => {
      const message = new EmailChangeProvision(newEmail, url)
      return send(message.kind, message.recipient, message.actionUrl)
    },
    emailChanged: (previousEmail) => send('emailChanged', previousEmail),
    passwordResetCompleted: (user) => send('passwordResetCompleted', user.email),
    passwordChanged: (user) => send('passwordChanged', user.email),
    socialIdentityLinked: (user, identity) =>
      send('socialIdentityLinked', user.email, undefined, resolveProviderLabel(identity.provider)),
    socialIdentityUnlinked: (user, identity) =>
      send(
        'socialIdentityUnlinked',
        user.email,
        undefined,
        resolveProviderLabel(identity.provider)
      ),
    magicLinkProvision: (user, url) => {
      const message = new MagicLinkProvision(user.email, url)
      return send(message.kind, message.recipient, message.actionUrl)
    },
    accountDeleted: (account) => send('accountDeleted', account.email),
  }
}

function resolveProviderLabel(provider: string): string {
  return isSocialProviderName(provider) ? socialProviderLabels[provider] : 'Social'
}
