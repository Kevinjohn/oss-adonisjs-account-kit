import type { Capability, NotificationCallbacks, UrlCallbacks } from './types.js'
import { isSocialProviderName, socialProviderLabels } from './social_providers.js'

export type AccountMessageKind = keyof NotificationCallbacks

export interface RenderedAccountMessage {
  subject: string
  text: string
  html: string
}

/** The small Mail surface used here keeps service-only imports independent of @adonisjs/mail. */
export interface AccountMailService {
  sendLater(callback: (message: AccountMailMessage) => void): Promise<unknown>
}

export interface AccountMailMessage {
  to(address: string): this
  from(address: string): this
  subject(subject: string): this
  html(content: string): this
  text(content: string): this
}

export interface MailNotificationOptions {
  /**
   * Defaults to the AdonisJS Mail service, resolved when a message is sent. Config files load
   * before that service exists, so pass a function rather than the service itself.
   */
  mail?: AccountMailService | (() => AccountMailService)
  from: string
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
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
  )
}

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
export class AccountActivationProvision {
  readonly kind = 'accountActivationProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}
export class InvitationProvision {
  readonly kind = 'invitationProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}
export class EmailChangeProvision {
  readonly kind = 'emailChangeProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}

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
  }
}

function providerLabel(provider: string): string {
  return isSocialProviderName(provider) ? socialProviderLabels[provider] : 'Social'
}

export interface ActionUrlOptions {
  backendOrigin: string
  appFrontendUrl: string
  destinations: Partial<Record<keyof UrlCallbacks, string>>
  environment: 'development' | 'test' | 'production'
}

function trustedOrigin(value: string, environment: ActionUrlOptions['environment']): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('account_kit: invalid configured origin')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  )
    throw new Error('account_kit: invalid configured origin')
  if (environment === 'production' && url.protocol !== 'https:')
    throw new Error('account_kit: public production origins require HTTPS')
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('account_kit: HTTP is restricted to loopback development origins')
  return url
}

/** Build links only from configured values; request Host and forwarded headers are never inputs. */
export function createActionUrls(options: ActionUrlOptions): UrlCallbacks {
  trustedOrigin(options.backendOrigin, options.environment)
  const frontend = trustedOrigin(options.appFrontendUrl, options.environment)
  const base = new URL(frontend.toString().replace(/\/?$/, '/'))
  function link(name: keyof UrlCallbacks, token: string): string {
    const destination = options.destinations[name]
    if (
      !destination ||
      destination.trim() !== destination ||
      destination.startsWith('/') ||
      destination.includes('..') ||
      destination.includes('\\') ||
      destination.includes('?') ||
      destination.includes('#') ||
      [...destination].some((character) => character.charCodeAt(0) < 32) ||
      /^[a-z][a-z\d+.-]*:/i.test(destination) ||
      destination.startsWith('//')
    )
      throw new Error(`account_kit: ${name} destination must be a relative path`)
    try {
      if (
        destination.split('/').some((segment) => {
          const decoded = decodeURIComponent(segment)
          return (
            decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')
          )
        })
      )
        throw new Error('unsafe path segment')
      const resolved = new URL(
        `${destination.replace(/\/?$/, '/')}${encodeURIComponent(token)}`,
        base
      )
      if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname))
        throw new Error('outside configured frontend')
      return resolved.toString()
    } catch {
      throw new Error(
        `account_kit: ${name} destination must stay below the configured frontend path`
      )
    }
  }
  for (const [name, destination] of Object.entries(options.destinations)) {
    if (destination !== undefined) link(name as keyof UrlCallbacks, 'check')
  }
  return {
    passwordReset: (token) => link('passwordReset', token),
    emailVerification: (token) => link('emailVerification', token),
    invitation: (token) => link('invitation', token),
    emailChange: (token) => link('emailChange', token),
    magicLink: (token) => link('magicLink', token),
  }
}

export interface NotificationReadinessInput {
  environment: ActionUrlOptions['environment']
  delivery: 'best-effort' | 'durable' | 'capture'
  /** The application's selected AdonisJS Mail transport behavior. */
  transport: 'delivery' | 'capture' | 'discard'
  backendOrigin: string
  actionOrigin: string
  enabled: Capability[]
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

export function notificationReadiness(input: NotificationReadinessInput) {
  const problems: string[] = []
  for (const [label, origin] of [
    ['backend', input.backendOrigin],
    ['action', input.actionOrigin],
  ]) {
    try {
      trustedOrigin(origin, input.environment)
    } catch (error) {
      problems.push(`${label}: ${(error as Error).message}`)
    }
  }
  if (input.environment === 'production' && input.delivery === 'capture')
    problems.push('capture is development only and does not deliver to recipients')
  if (input.transport === 'discard')
    problems.push('discard transport does not deliver or capture account messages')
  if (input.transport === 'capture' && input.delivery !== 'capture')
    problems.push('capture transport requires capture delivery classification')
  if (input.transport === 'delivery' && input.delivery === 'capture')
    problems.push('capture delivery classification requires a capture transport')
  if (input.environment === 'production' && input.transport !== 'delivery')
    problems.push('production mail transport must deliver to recipients')
  if (
    input.delivery === 'durable' &&
    (!input.durableChecks?.worker ||
      !input.durableChecks.retries ||
      !input.durableChecks.terminalFailures ||
      !input.durableChecks.actionLinks ||
      !input.durableChecks.securityNotices)
  )
    problems.push(
      'durable delivery requires verified worker, retries, terminal failure reporting, action links and security notices'
    )
  const required: (keyof UrlCallbacks)[] = []
  if (input.enabled.includes('passwordReset')) required.push('passwordReset')
  if (input.enabled.includes('emailVerification') || input.enabled.includes('registration'))
    required.push('emailVerification')
  if (input.enabled.includes('invitations')) required.push('invitation')
  if (input.enabled.includes('emailPasswordManagement')) required.push('emailChange')
  if (input.enabled.includes('magicLinkLogin')) required.push('magicLink')
  for (const name of required)
    if (!input.destinations[name]) problems.push(`${name} destination is required`)
  try {
    createActionUrls({
      backendOrigin: input.backendOrigin,
      appFrontendUrl: input.actionOrigin,
      destinations: input.destinations,
      environment: input.environment,
    })
  } catch (error) {
    problems.push((error as Error).message)
  }
  const classification =
    input.transport === 'discard'
      ? 'discarded'
      : input.transport === 'capture'
        ? 'development capture'
        : input.delivery === 'durable'
          ? 'application declared durable'
          : 'best effort'
  const notes =
    classification === 'development capture'
      ? ['Captured for development; no message was delivered to a recipient.']
      : classification === 'discarded'
        ? ['Messages are discarded and cannot be recovered from this transport.']
        : input.delivery === 'durable'
          ? ['Verify application worker, retry, terminal failure and deduplication operations.']
          : [
              'Best effort has no package retry or crash recovery; diagnose failures and do not replay committed mutations.',
            ]
  return { ready: problems.length === 0, classification, problems, notes }
}
