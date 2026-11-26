import type { NotificationKind, CapturedNotification } from '../types_testing.ts'
import { RuntimeException } from '@adonisjs/core/exceptions'
import type { NotificationCallbacks } from '../types.ts'

function tokenFrom(actionUrl: string): string | undefined {
  const url = new URL(actionUrl)
  const query = url.searchParams.get('token')
  if (query) return query
  const segment = url.pathname.split('/').filter(Boolean).at(-1)
  return segment === undefined ? undefined : decodeURIComponent(segment)
}

/**
 * Records account notifications in memory for application tests. Pass `notify` as the
 * Account Kit `notify` config, run an operation, then read the link or token it produced.
 *
 * @example
 * ```ts
 * import { captureNotifications } from '@kevinjohn/adonisjs-account-kit/testing/notifications'
 *
 * const mail = captureNotifications()
 * const config = { ...accountConfig, notify: mail.notify }
 * ```
 */
export function captureNotifications() {
  return new NotificationCapture()
}

/**
 * In-memory messages recorded by the capture helper.
 *
 * @example
 * ```ts
 * import { NotificationCapture } from '@kevinjohn/adonisjs-account-kit/testing/notifications'
 *
 * const mail = new NotificationCapture()
 * ```
 */
export class NotificationCapture {
  readonly messages: CapturedNotification[] = []
  #record(kind: NotificationKind, to: string, args: unknown[], actionUrl?: string) {
    this.messages.push({
      kind,
      to,
      args,
      ...(actionUrl ? { actionUrl, token: tokenFrom(actionUrl) } : {}),
    })
    return Promise.resolve()
  }
  readonly notify: NotificationCallbacks = {
    passwordResetProvision: (user, url) =>
      this.#record('passwordResetProvision', user.email, [user, url], url),
    accountActivationProvision: (user, url) =>
      this.#record(
        'accountActivationProvision',
        user.unverifiedEmail ?? user.email,
        [user, url],
        url
      ),
    invitationProvision: (invitation, url) =>
      this.#record('invitationProvision', invitation.email, [invitation, url], url),
    emailChangeProvision: (user, newEmail, url) =>
      this.#record('emailChangeProvision', newEmail, [user, newEmail, url], url),
    emailChanged: (previousEmail, user) =>
      this.#record('emailChanged', previousEmail, [previousEmail, user]),
    passwordResetCompleted: (user, context) =>
      this.#record('passwordResetCompleted', user.email, [user, context]),
    passwordChanged: (user, context) =>
      this.#record('passwordChanged', user.email, [user, context]),
    socialIdentityLinked: (user, identity) =>
      this.#record('socialIdentityLinked', user.email, [user, identity]),
    socialIdentityUnlinked: (user, identity) =>
      this.#record('socialIdentityUnlinked', user.email, [user, identity]),
    magicLinkProvision: (user, url) =>
      this.#record('magicLinkProvision', user.email, [user, url], url),
    accountDeleted: (account) => this.#record('accountDeleted', account.email, [account]),
  }
  /**
   * Find the latest matching notification, optionally for one address.
   *
   * @example
   * ```ts
   * const sent = mail.last('passwordResetProvision', 'sam@example.test')
   * ```
   */
  last(kind: NotificationKind, to?: string): CapturedNotification | undefined {
    return this.messages.findLast(
      (message) => message.kind === kind && (to === undefined || message.to === to)
    )
  }
  /**
   * The token from the latest matching message; throws when none was sent.
   *
   * @example
   * ```ts
   * const token = mail.tokenFor('passwordResetProvision', 'sam@example.test')
   * ```
   */
  tokenFor(kind: NotificationKind, to?: string): string {
    const token = this.last(kind, to)?.token
    if (!token)
      throw new RuntimeException(`No ${kind} notification with a token${to ? ` to ${to}` : ''}`)
    return token
  }

  /**
   * Forget every captured message.
   *
   * @example
   * ```ts
   * mail.clear()
   * ```
   */
  clear(): void {
    this.messages.length = 0
  }
}

export type { NotificationKind, CapturedNotification } from '../types_testing.ts'
