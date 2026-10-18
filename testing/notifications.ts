import type { NotificationCallbacks } from '../src/types.js'

export type NotificationKind = keyof NotificationCallbacks

export interface CapturedNotification {
  kind: NotificationKind
  /** The address the built-in mail notifications would send this message to. */
  to: string
  actionUrl?: string
  /** The proof token from the action URL: its `token` query value, else its last path segment. */
  token?: string
  /** The raw callback arguments, for assertions on users, invitations and contexts. */
  args: unknown[]
}

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
 */
export function captureNotifications() {
  const messages: CapturedNotification[] = []
  function record(kind: NotificationKind, to: string, args: unknown[], actionUrl?: string) {
    messages.push({
      kind,
      to,
      args,
      ...(actionUrl ? { actionUrl, token: tokenFrom(actionUrl) } : {}),
    })
    return Promise.resolve()
  }
  const notify: NotificationCallbacks = {
    passwordResetProvision: (user, url) =>
      record('passwordResetProvision', user.email, [user, url], url),
    accountActivationProvision: (user, url) =>
      record('accountActivationProvision', user.unverifiedEmail ?? user.email, [user, url], url),
    invitationProvision: (invitation, url) =>
      record('invitationProvision', invitation.email, [invitation, url], url),
    emailChangeProvision: (user, newEmail, url) =>
      record('emailChangeProvision', newEmail, [user, newEmail, url], url),
    emailChanged: (previousEmail, user) =>
      record('emailChanged', previousEmail, [previousEmail, user]),
    passwordResetCompleted: (user, context) =>
      record('passwordResetCompleted', user.email, [user, context]),
    passwordChanged: (user, context) => record('passwordChanged', user.email, [user, context]),
    socialIdentityLinked: (user, identity) =>
      record('socialIdentityLinked', user.email, [user, identity]),
    socialIdentityUnlinked: (user, identity) =>
      record('socialIdentityUnlinked', user.email, [user, identity]),
    magicLinkProvision: (user, url) => record('magicLinkProvision', user.email, [user, url], url),
    accountDeleted: (account) => record('accountDeleted', account.email, [account]),
  }
  function last(kind: NotificationKind, to?: string): CapturedNotification | undefined {
    return messages.findLast(
      (message) => message.kind === kind && (to === undefined || message.to === to)
    )
  }
  return {
    notify,
    messages,
    last,
    /** The token from the latest matching message; throws when none was sent. */
    tokenFor(kind: NotificationKind, to?: string): string {
      const token = last(kind, to)?.token
      if (!token) throw new Error(`No ${kind} notification with a token${to ? ` to ${to}` : ''}`)
      return token
    },
    clear() {
      messages.length = 0
    },
  }
}
