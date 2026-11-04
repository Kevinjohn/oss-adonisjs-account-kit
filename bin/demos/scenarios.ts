import { createHash, randomBytes } from 'node:crypto'
import type { Cast } from './cast.js'
export type HttpOptions = { body?: Record<string, unknown>; token?: string }
type HttpResult = { status: number; body: Record<string, string>; raw: string }
type ScenarioTools = {
  ace: (...args: string[]) => Promise<string>
  http: (
    cast: Cast,
    method: string,
    path: string | undefined,
    options?: HttpOptions & { tokenName?: string }
  ) => Promise<HttpResult>
  curl: (method: string, path: string | undefined, options?: HttpOptions) => Promise<HttpResult>
  showMail: (cast: Cast, to: string) => Promise<string | undefined>
  skipMail: () => void
  verifiedUser: (email: string) => Promise<string>
  password: string
}

export const createScenarios = ({
  ace,
  http,
  curl,
  showMail,
  skipMail,
  verifiedUser,
  password,
}: ScenarioTools) => ({
  async 'doctor'(cast: Cast) {
    cast.comment('check the install: config, limiter, APP_URL and tables')
    cast.type('node ace account-kit:doctor')
    const output = await ace('account-kit:doctor')
    cast.print(output.replaceAll('[ success ]', '\x1b[32m[ success ]\x1b[0m'))
  },

  async 'password-reset'(cast: Cast) {
    await verifiedUser('ada@example.com')
    skipMail()
    cast.comment('request a reset: the same answer whether or not the account exists')
    await http(cast, 'POST', '/api/auth/password-reset', { body: { email: 'ada@example.com' } })
    await http(cast, 'POST', '/api/auth/password-reset', { body: { email: 'nobody@example.com' } })
    cast.comment('only the real account gets an email')
    const path = await showMail(cast, 'ada@example.com')
    cast.comment('use the link once')
    const next = { password: 'a new long password', passwordConfirmation: 'a new long password' }
    await http(cast, 'POST', path, { body: next })
    cast.comment('a second use is rejected')
    await http(cast, 'POST', path, { body: next })
  },

  async 'signup-verification'(cast: Cast) {
    cast.comment('sign up: the account starts unverified')
    await http(cast, 'POST', '/api/auth/signup', {
      body: { email: 'grace@example.com', password, passwordConfirmation: password },
    })
    const path = await showMail(cast, 'grace@example.com')
    cast.comment('open the link to confirm the address')
    await http(cast, 'POST', path, { body: { password, passwordConfirmation: password } })
    cast.comment('signing in now gives an active account')
    await http(cast, 'POST', '/api/auth/login', { body: { email: 'grace@example.com', password } })
  },

  async 'invitations'(cast: Cast) {
    const token = await verifiedUser('owner@example.com')
    skipMail()
    cast.comment('invite a teammate with a role')
    await http(cast, 'POST', '/api/account/invitations', {
      token,
      body: { email: 'lin@example.com', role: 'editor' },
    })
    const path = await showMail(cast, 'lin@example.com')
    cast.comment('the invitee checks the link, then sets a password')
    await http(cast, 'GET', path)
    await http(cast, 'POST', path, { body: { password, passwordConfirmation: password } })
    cast.comment('the link works once')
    await http(cast, 'POST', path, { body: { password, passwordConfirmation: password } })
  },

  async 'email-change'(cast: Cast) {
    const token = await verifiedUser('mo@example.com')
    skipMail()
    cast.comment('change email: confirm with the current password')
    await http(cast, 'PATCH', '/api/account/profile', {
      token,
      body: { email: 'mo@new.example.com', currentPassword: password },
    })
    cast.comment('the new address gets a confirmation link')
    const path = await showMail(cast, 'mo@new.example.com')
    await http(cast, 'POST', path)
    cast.comment('the old address is told about the change')
    await showMail(cast, 'mo@example.com')
  },

  async 'password-change'(cast: Cast) {
    await verifiedUser('kai@example.com')
    cast.comment('signed in on two devices')
    const laptopLogin = await http(cast, 'POST', '/api/auth/login', {
      body: { email: 'kai@example.com', password },
    })
    const laptop = laptopLogin.body.token
    const phoneLogin = await curl('POST', '/api/auth/login', {
      body: { email: 'kai@example.com', password },
    })
    const phone = phoneLogin.body.token
    cast.comment('change the password from the laptop')
    await http(cast, 'POST', '/api/account/password', {
      token: laptop,
      tokenName: 'LAPTOP',
      body: {
        currentPassword: password,
        newPassword: 'another long password',
        newPasswordConfirmation: 'another long password',
      },
    })
    cast.comment('the phone is signed out')
    await http(cast, 'GET', '/api/account/profile', { token: phone, tokenName: 'PHONE' })
  },

  async 'login-throttling'(cast: Cast) {
    await verifiedUser('sam@example.com')
    cast.comment('wrong passwords get one generic error')
    for (let i = 0; i < 5; i++)
      await http(cast, 'POST', '/api/auth/login', {
        body: { email: 'sam@example.com', password: 'guess' + i },
      })
    cast.comment('then the address is blocked for a while, even with the right password')
    await http(cast, 'POST', '/api/auth/login', { body: { email: 'sam@example.com', password } })
  },

  async 'magic-link'(cast: Cast) {
    await verifiedUser('ivy@example.com')
    skipMail()
    const verifier = randomBytes(32).toString('base64url')
    const clientChallenge = createHash('sha256').update(verifier).digest('base64url')
    cast.comment('the app keeps a secret verifier and sends only its hash')
    await http(cast, 'POST', '/api/auth/magic-link', {
      body: { email: 'ivy@example.com', clientChallenge },
    })
    const path = await showMail(cast, 'ivy@example.com')
    cast.comment('opened somewhere else, without the right verifier: it fails and is used up')
    await http(cast, 'POST', path, { body: { verifier: randomBytes(32).toString('base64url') } })
    cast.comment('ask again; the app that asked signs in')
    await http(cast, 'POST', '/api/auth/magic-link', {
      body: { email: 'ivy@example.com', clientChallenge },
    })
    const second = await showMail(cast, 'ivy@example.com')
    await http(cast, 'POST', second, { body: { verifier } })
  },

  async 'devices'(cast: Cast) {
    await verifiedUser('noor@example.com')
    const tokens = []
    for (let i = 0; i < 2; i++) {
      const login = await curl('POST', '/api/auth/login', {
        body: { email: 'noor@example.com', password },
      })
      tokens.push(login.body.token)
    }
    cast.comment('list where this account is signed in')
    await http(cast, 'GET', '/api/account/sessions', { token: tokens[0] })
    cast.comment('sign out every other device')
    await http(cast, 'POST', '/api/account/sessions/revoke-others', { token: tokens[0] })
    await http(cast, 'GET', '/api/account/sessions', { token: tokens[0] })
  },

  async 'export-deletion'(cast: Cast) {
    const token = await verifiedUser('eli@example.com')
    cast.comment('download your data; re-enter the password first')
    await http(cast, 'POST', '/api/account/export', { token, body: { currentPassword: password } })
    cast.comment('delete the account')
    await http(cast, 'DELETE', '/api/account', { token, body: { currentPassword: password } })
    await showMail(cast, 'eli@example.com')
    cast.comment('the account is gone')
    await http(cast, 'POST', '/api/auth/login', { body: { email: 'eli@example.com', password } })
  },

  async 'operator-commands'(cast: Cast) {
    await verifiedUser('support@example.com')
    cast.comment('a reset link from a trusted shell, for support cases')
    cast.type('node ace account-kit:reset-link support@example.com')
    const resetLink = await ace('account-kit:reset-link', 'support@example.com')
    const output = resetLink.trim().split('\n')
    for (const line of output) {
      const entry = line.startsWith('{"level"') ? JSON.parse(line).msg : line
      const mail = entry.startsWith('[account-kit] mail to')
      const shown = mail ? entry.split('\n')[0].replace('[account-kit] ', '[log] ') : entry
      cast.print(mail ? `\x1b[36m${shown}\x1b[0m` : shown)
    }
    cast.comment('delete expired tokens; schedule this')
    cast.type('node ace account-kit:prune')
    cast.print(await ace('account-kit:prune'))
  },
})
