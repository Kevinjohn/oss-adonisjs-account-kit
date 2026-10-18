import type { NotificationCallbacks } from '../../src/types.js'

export type NotifyCall = { method: keyof NotificationCallbacks; args: unknown[] }
export function makeNotify() {
  const calls: NotifyCall[] = []
  let failing: keyof NotificationCallbacks | null = null
  const record = async (method: NotifyCall['method'], ...args: unknown[]) => {
    calls.push({ method, args })
    if (failing === method) throw new Error(`notify.${method} failed`)
  }
  const notify: NotificationCallbacks = {
    passwordResetProvision: (user, url) => record('passwordResetProvision', user, url),
    accountActivationProvision: (user, url) => record('accountActivationProvision', user, url),
    invitationProvision: (invitation, url) => record('invitationProvision', invitation, url),
    emailChangeProvision: (user, newEmail, url) =>
      record('emailChangeProvision', user, newEmail, url),
    emailChanged: (previousEmail, user) => record('emailChanged', previousEmail, user),
    passwordResetCompleted: (user, context) => record('passwordResetCompleted', user, context),
    passwordChanged: (user, context) => record('passwordChanged', user, context),
    socialIdentityLinked: (user, identity) => record('socialIdentityLinked', user, identity),
    socialIdentityUnlinked: (user, identity) => record('socialIdentityUnlinked', user, identity),
  }
  return {
    notify,
    calls,
    failOn(method: keyof NotificationCallbacks | null) {
      failing = method
    },
  }
}
