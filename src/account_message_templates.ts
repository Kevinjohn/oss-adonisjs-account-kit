import type { NotificationCallbacks } from './types.js'
import type { AccountKitTranslator } from './translator.js'

export type AccountMessageKind = keyof NotificationCallbacks

/** A rendered account email: subject, plain text and HTML. */
export interface RenderedAccountMessage {
  subject: string
  text: string
  html: string
}

const templates: Record<
  AccountMessageKind,
  { subject: string; heading: string; body: string; action?: string }
> = {
  passwordResetProvision: {
    subject: '{brandName}: Reset your password',
    heading: 'Reset your password',
    body: 'Use the link below to set a new password. If you did not request this, you can ignore this message.',
    action: 'Reset password',
  },
  accountActivationProvision: {
    subject: '{brandName}: Confirm your email address',
    heading: 'Confirm your email address',
    body: 'Use the link below to confirm your email address.',
    action: 'Confirm email address',
  },
  invitationProvision: {
    subject: '{brandName}: You are invited',
    heading: 'You are invited',
    body: 'Use the link below to accept your invitation.',
    action: 'Accept invitation',
  },
  emailChangeProvision: {
    subject: '{brandName}: Confirm your new email address',
    heading: 'Confirm your new email address',
    body: 'Use the link below to confirm this email address.',
    action: 'Confirm new email address',
  },
  emailChanged: {
    subject: '{brandName}: Your email address changed',
    heading: 'Your email address changed',
    body: 'The email address on your account was changed. If this was unexpected, contact support immediately.',
  },
  passwordResetCompleted: {
    subject: '{brandName}: Your password was reset',
    heading: 'Your password was reset',
    body: 'The password on your account was reset. If this was unexpected, contact support immediately.',
  },
  passwordChanged: {
    subject: '{brandName}: Your password changed',
    heading: 'Your password changed',
    body: 'The password on your account was changed. If this was unexpected, contact support immediately.',
  },
  socialIdentityLinked: {
    subject: '{brandName}: A social sign-in method was linked',
    heading: 'A social sign-in method was linked',
    body: '{provider} sign-in was linked to your account. If this was unexpected, contact support immediately.',
  },
  socialIdentityUnlinked: {
    subject: '{brandName}: A social sign-in method was removed',
    heading: 'A social sign-in method was removed',
    body: '{provider} sign-in was removed from your account. If this was unexpected, contact support immediately.',
  },
  magicLinkProvision: {
    subject: '{brandName}: Your sign-in link',
    heading: 'Sign in',
    body: 'Use the link below to sign in. Open it in the browser or app where you asked for it. It works once and expires soon. If you did not ask to sign in, you can ignore this message.',
    action: 'Sign in',
  },
  accountDeleted: {
    subject: '{brandName}: Your account was deleted',
    heading: 'Your account was deleted',
    body: 'Your account and its sign-in details were deleted. If this was unexpected, contact support immediately.',
  },
}

const copyLinkTemplate = 'Or copy this link: {url}'

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
  )
}

/**
 * Renders the built-in template for one kind of account email. Use it to send through your own
 * transport with the same wording. With `i18n`, each part is looked up as
 * `account_kit.emails.<kind>.<part>` and falls back to the English text.
 */
export function renderAccountMessage(
  kind: AccountMessageKind,
  values: { brandName: string; actionUrl?: string; providerName?: string },
  emailLayout?: (body: string) => string,
  options: { i18n?: AccountKitTranslator } = {}
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
  const data = { brandName: values.brandName, provider: values.providerName, url: values.actionUrl }
  const translate = (key: string, english: string) => {
    // @adonisjs/i18n returns the fallback verbatim, so it must already be interpolated.
    const fallback = english.replace(
      /\{(brandName|provider|url)\}/g,
      (_, name: keyof typeof data) => data[name] ?? ''
    )
    return options.i18n ? options.i18n.t(`account_kit.emails.${key}`, data, fallback) : fallback
  }
  const subject = translate(`${kind}.subject`, template.subject)
  const heading = translate(`${kind}.heading`, template.heading)
  const messageBody = translate(`${kind}.body`, template.body)
  const action = template.action && translate(`${kind}.action`, template.action)
  const copyLink = action && translate('copy_link', copyLinkTemplate)
  const actionText = action ? `\n\n${action}: ${values.actionUrl}` : ''
  const text = `${values.brandName}\n\n${heading}\n\n${messageBody}${actionText}\n`
  const body = `<main><p>${escapeHtml(values.brandName)}</p><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(messageBody)}</p>${action ? `<p><a href="${escapeHtml(values.actionUrl!)}">${escapeHtml(action)}</a></p><p>${escapeHtml(copyLink!)}</p>` : ''}</main>`
  const lang = escapeHtml(options.i18n?.locale ?? 'en')
  return {
    subject,
    text,
    html: emailLayout
      ? emailLayout(body)
      : `<!doctype html><html lang="${lang}"><body>${body}</body></html>`,
  }
}
