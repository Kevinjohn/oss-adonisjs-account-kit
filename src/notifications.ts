import { MagicLinkProvision } from './magic_link_provision.ts'
import { EmailChangeProvision } from './email_change_provision.ts'
import { InvitationProvision } from './invitation_provision.ts'
import { AccountActivationProvision } from './account_activation_provision.ts'
import { PasswordResetProvision } from './password_reset_provision.ts'
import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
import type { NotificationCallbacks } from './types.ts'
import type { AccountKitTranslator } from './translator.ts'
import { isSocialProviderName, socialProviderLabels } from './social_providers.ts'
import { renderAccountMessage, type AccountMessageKind } from './account_message_templates.ts'
import type { AccountMailService, MailNotificationOptions } from './types_notifications.ts'

export type {
  AccountMailMessage,
  AccountMailService,
  MailNotificationOptions,
} from './types_notifications.ts'

export {
  renderAccountMessage,
  type AccountMessageKind,
  type RenderedAccountMessage,
} from './account_message_templates.ts'

export { createActionUrls, type ActionUrlOptions } from './action_urls.ts'
export { notificationReadiness, type NotificationReadinessInput } from './notification_readiness.ts'

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
  return new MailNotifications(options)
}

class MailNotifications implements NotificationCallbacks {
  #options: MailNotificationOptions

  constructor(options: MailNotificationOptions) {
    this.#options = options
    if (
      !options.from?.trim() ||
      !options.brandName?.trim() ||
      /[\r\n]/.test(options.from) ||
      /[\r\n]/.test(options.brandName)
    )
      throw new InvalidArgumentsException('account_kit: from and brandName are required')
  }

  async #send(
    kind: AccountMessageKind,
    recipient: string,
    actionUrl?: string,
    providerName?: string
  ) {
    const rendered = renderAccountMessage(
      kind,
      { brandName: this.#options.brandName, actionUrl, providerName },
      this.#options.emailLayout,
      { i18n: resolveTranslator(this.#options.i18n) }
    )
    const mail = await resolveMail(this.#options.mail)
    await mail.sendLater((message) => {
      message
        .to(recipient)
        .from(this.#options.from)
        .subject(rendered.subject)
        .html(rendered.html)
        .text(rendered.text)
    })
  }

  passwordResetProvision: NotificationCallbacks['passwordResetProvision'] = (user, url) => {
    const message = new PasswordResetProvision(user.email, url)
    return this.#send(message.kind, message.recipient, message.actionUrl)
  }

  accountActivationProvision: NotificationCallbacks['accountActivationProvision'] = (user, url) => {
    const message = new AccountActivationProvision(user.unverifiedEmail ?? user.email, url)
    return this.#send(message.kind, message.recipient, message.actionUrl)
  }

  invitationProvision: NotificationCallbacks['invitationProvision'] = (invitation, url) => {
    const message = new InvitationProvision(invitation.email, url)
    return this.#send(message.kind, message.recipient, message.actionUrl)
  }

  emailChangeProvision: NotificationCallbacks['emailChangeProvision'] = (_user, newEmail, url) => {
    const message = new EmailChangeProvision(newEmail, url)
    return this.#send(message.kind, message.recipient, message.actionUrl)
  }

  emailChanged: NotificationCallbacks['emailChanged'] = (previousEmail) =>
    this.#send('emailChanged', previousEmail)

  passwordResetCompleted: NotificationCallbacks['passwordResetCompleted'] = (user) =>
    this.#send('passwordResetCompleted', user.email)

  passwordChanged: NotificationCallbacks['passwordChanged'] = (user) =>
    this.#send('passwordChanged', user.email)

  socialIdentityLinked: NotificationCallbacks['socialIdentityLinked'] = (user, identity) =>
    this.#send(
      'socialIdentityLinked',
      user.email,
      undefined,
      resolveProviderLabel(identity.provider)
    )

  socialIdentityUnlinked: NotificationCallbacks['socialIdentityUnlinked'] = (user, identity) =>
    this.#send(
      'socialIdentityUnlinked',
      user.email,
      undefined,
      resolveProviderLabel(identity.provider)
    )

  magicLinkProvision: NotificationCallbacks['magicLinkProvision'] = (user, url) => {
    const message = new MagicLinkProvision(user.email, url)
    return this.#send(message.kind, message.recipient, message.actionUrl)
  }

  accountDeleted: NotificationCallbacks['accountDeleted'] = (account) =>
    this.#send('accountDeleted', account.email)
}

function resolveProviderLabel(provider: string): string {
  return isSocialProviderName(provider) ? socialProviderLabels[provider] : 'Social'
}

export { PasswordResetProvision } from './password_reset_provision.ts'

export { AccountActivationProvision } from './account_activation_provision.ts'

export { InvitationProvision } from './invitation_provision.ts'

export { EmailChangeProvision } from './email_change_provision.ts'

export { MagicLinkProvision } from './magic_link_provision.ts'
