import type { AccountKitConfig, AccountUser, Invitation, Trx } from '../../src/types.js'
import { allowAll } from './authorizers.js'
import { makeNotify } from './notifications.js'

export function makeConfig(
  overrides: Pick<AccountKitConfig, 'users'> & Partial<Omit<AccountKitConfig, 'users'>>
): AccountKitConfig {
  const { notify } = makeNotify()
  return {
    limiterSecret: 'test_only_shared_limiter_secret_32_bytes',
    registration: { availability: 'open' },
    enabled: ['passwordReset', 'emailVerification', 'invitations', 'emailPasswordManagement'],
    authorize: allowAll,
    urls: {
      passwordReset: (token) => `https://example.test/recovery/${token}`,
      emailVerification: (token) => `https://example.test/verification/${token}`,
      invitation: (token) => `https://example.test/invitation/${token}`,
      emailChange: (token) => `https://example.test/email-change/${token}`,
      magicLink: (token) => `https://example.test/magic-link/${token}`,
    },
    notify,
    onInvitationAccepted: async (_user: AccountUser, _invitation: Invitation, _trx: Trx) => {},
    ...overrides,
  }
}

/** The token is the last path segment of every URL built by `makeConfig`. */
export const tokenFrom = (url: unknown) => new URL(url as string).pathname.split('/').at(-1)!
