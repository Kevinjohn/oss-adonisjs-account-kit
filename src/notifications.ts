import type { NotificationCallbacks } from './types.js'
import { isSocialProviderName, socialProviderLabels } from './social_providers.js'

export { createActionUrls, type ActionUrlOptions } from './action_urls.js'
export { notificationReadiness, type NotificationReadinessInput } from './notification_readiness.js'

export type AccountMessageKind = keyof NotificationCallbacks

/** A rendered account email: subject, plain text and HTML. */
export interface RenderedAccountMessage {
  subject: string
  text: string
  html: string
}

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
}

const templates: Record<
  AccountMessageKind,
  { subject: string; heading: string; body: string; action?: string }
> = {
  passwordResetProvision: {
    subject: 'Reset your password',
    heading: 'Reset your password',
    body: 'Use the link below to set a new password. If you did not request this, you can ignore this message.',
    action: 'Reset password',
  },
  accountActivationProvision: {
    subject: 'Confirm your email address',
    heading: 'Confirm your email address',
    body: 'Use the link below to confirm your email address.',
    action: 'Confirm email address',
  },
  invitationProvision: {
    subject: 'You are invited',
    heading: 'You are invited',
    body: 'Use the link below to accept your invitation.',
    action: 'Accept invitation',
  },
  emailChangeProvision: {
    subject: 'Confirm your new email address',
    heading: 'Confirm your new email address',
    body: 'Use the link below to confirm this email address.',
    action: 'Confirm new email address',
  },
  emailChanged: {
    subject: 'Your email address changed',
    heading: 'Your email address changed',
    body: 'The email address on your account was changed. If this was unexpected, contact support immediately.',
  },
  passwordResetCompleted: {
    subject: 'Your password was reset',
    heading: 'Your password was reset',
    body: 'The password on your account was reset. If this was unexpected, contact support immediately.',
  },
  passwordChanged: {
    subject: 'Your password changed',
    heading: 'Your password changed',
    body: 'The password on your account was changed. If this was unexpected, contact support immediately.',
  },
  socialIdentityLinked: {
    subject: 'A social sign-in method was linked',
    heading: 'A social sign-in method was linked',
    body: '{provider} sign-in was linked to your account. If this was unexpected, contact support immediately.',
  },
  socialIdentityUnlinked: {
    subject: 'A social sign-in method was removed',
    heading: 'A social sign-in method was removed',
    body: '{provider} sign-in was removed from your account. If this was unexpected, contact support immediately.',
  },
  magicLinkProvision: {
    subject: 'Your sign-in link',
    heading: 'Sign in',
    body: 'Use the link below to sign in. Open it in the browser or app where you asked for it. It works once and expires soon. If you did not ask to sign in, you can ignore this message.',
    action: 'Sign in',
  },
  accountDeleted: {
    subject: 'Your account was deleted',
    heading: 'Your account was deleted',
    body: 'Your account and its sign-in details were deleted. If this was unexpected, contact support immediately.',
  },
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
  )
}

/**
 * Renders the built-in English template for one kind of account email. Use it to send through your
 * own transport with the same wording.
 */
export function renderAccountMessage(
  kind: AccountMessageKind,
  values: { brandName: string; actionUrl?: string; providerName?: string },
  emailLayout?: (body: string) => string
): RenderedAccountMessage {
  const template = templates[kind]
  if (template.action && !values.actionUrl)
    throw new Error(`account_kit: ${kind} requires an action URL`)
  if (values.actionUrl) {
    let url: URL
    try {
      url = new URL(values.actionUrl)
    } catch {
      throw new Error('account_kit: action URL must be absolute')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('account_kit: action URL must be a trusted HTTP(S) URL')
  }
  if (template.body.includes('{provider}') && !values.providerName)
    throw new Error(`account_kit: ${kind} requires a provider name`)
  const messageBody = template.body.replace('{provider}', values.providerName ?? '')
  const subject = `${values.brandName}: ${template.subject}`
  const actionText = template.action ? `\n\n${template.action}: ${values.actionUrl}` : ''
  const text = `${values.brandName}\n\n${template.heading}\n\n${messageBody}${actionText}\n`
  const body = `<main><p>${escapeHtml(values.brandName)}</p><h1>${escapeHtml(template.heading)}</h1><p>${escapeHtml(messageBody)}</p>${template.action ? `<p><a href="${escapeHtml(values.actionUrl!)}">${escapeHtml(template.action)}</a></p><p>Or copy this link: ${escapeHtml(values.actionUrl!)}</p>` : ''}</main>`
  return {
    subject,
    text,
    html: emailLayout
      ? emailLayout(body)
      : `<!doctype html><html lang="en"><body>${body}</body></html>`,
  }
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

async function resolveMail(option: MailNotificationOptions['mail']): Promise<AccountMailService> {
  if (typeof option === 'function') return option()
  if (option) return option
  const { default: mail } = await import('@adonisjs/mail/services/main')
  return mail
}

/**
 * Implements every notification callback with AdonisJS Mail and the built-in English templates.
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
      options.emailLayout
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
