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
  sendLater(callback: (message: AccountMailMessage) => void): Promise<unknown>
}

/** The part of an AdonisJS Mail message `createMailNotifications` uses. */
export interface AccountMailMessage {
  to(address: string): this
  from(address: string): this
  subject(subject: string): this
  html(content: string): this
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

/** Maintained action-link values; pass their rendered content through createMailNotifications. */
export class PasswordResetProvision {
  readonly kind = 'passwordResetProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}
/** An account activation email to send: recipient and action URL. */
export class AccountActivationProvision {
  readonly kind = 'accountActivationProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}
/** An invitation email to send: recipient and action URL. */
export class InvitationProvision {
  readonly kind = 'invitationProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}
/** An email-change confirmation to send: recipient and action URL. */
export class EmailChangeProvision {
  readonly kind = 'emailChangeProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}

/** A magic sign-in link email to send: recipient and action URL. */
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
 */
export function createMailNotifications(options: MailNotificationOptions): NotificationCallbacks {
  if (
    !options.from?.trim() ||
    !options.brandName?.trim() ||
    /[\r\n]/.test(options.from) ||
    /[\r\n]/.test(options.brandName)
  )
    throw new Error('account_kit: from and brandName are required')
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
      send('socialIdentityLinked', user.email, undefined, providerLabel(identity.provider)),
    socialIdentityUnlinked: (user, identity) =>
      send('socialIdentityUnlinked', user.email, undefined, providerLabel(identity.provider)),
    magicLinkProvision: (user, url) => {
      const message = new MagicLinkProvision(user.email, url)
      return send(message.kind, message.recipient, message.actionUrl)
    },
    accountDeleted: (account) => send('accountDeleted', account.email),
  }
}

function providerLabel(provider: string): string {
  return isSocialProviderName(provider) ? socialProviderLabels[provider] : 'Social'
}
