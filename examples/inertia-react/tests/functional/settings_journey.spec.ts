/* eslint-disable @unicorn/no-await-expression-member -- Keep each HTTP response beside its assertion. */
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import kit from 'adonisjs-account-kit/services/main'
import { setupAccountDatabase } from '../helpers/account_database.js'

const origin = process.env.APP_URL!
const currentPassword = 'OldPass123!'

class BrowserSession {
  private cookies = new Map<string, string>()
  private version: string | undefined

  async request(path: string, form?: Record<string, string>) {
    const headers = new Headers({
      'cookie': [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      'x-inertia': 'true',
    })
    if (this.version) headers.set('x-inertia-version', this.version)
    if (form) {
      headers.set('content-type', 'application/x-www-form-urlencoded')
      headers.set('x-xsrf-token', decodeURIComponent(this.cookies.get('XSRF-TOKEN') ?? ''))
      headers.set('referer', new URL(path, origin).href)
    }
    const response = await fetch(new URL(path, origin), {
      method: form ? 'POST' : 'GET',
      headers,
      body: form ? new URLSearchParams(form) : undefined,
      redirect: 'manual',
    })
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(';')[0].split('=', 2)
      if (name) this.cookies.set(name, value ?? '')
    }
    return response
  }

  async login(user: User) {
    const page = await this.request('/login')
    this.version = ((await page.json()) as { version: string }).version
    return this.request('/login', { email: user.email, password: currentPassword })
  }

  async props(path: string) {
    const response = await this.request(path)
    return {
      status: response.status,
      props: (await response.json()) as {
        props: {
          profile?: { fullName: string }
          user?: { id: number }
          valid?: boolean
          canRequestChange?: boolean
        }
      },
    }
  }
}

test.group('profile and email settings HTTP journey', (group) => {
  group.each.setup(setupAccountDatabase)

  test('settings bind reads and profile writes to the signed-in owner', async ({ assert }) => {
    const owner = await User.create({
      id: 1001,
      fullName: 'Owner',
      email: 'owner@example.test',
      password: currentPassword,
    })
    const other = await User.create({
      id: 1002,
      fullName: 'Other',
      email: 'other@example.test',
      password: currentPassword,
    })
    const ownerBrowser = new BrowserSession()
    const otherBrowser = new BrowserSession()
    assert.equal((await ownerBrowser.login(owner)).status, 302)
    assert.equal((await otherBrowser.login(other)).status, 302)
    const read = await ownerBrowser.props('/settings/profile')
    assert.equal(read.status, 200)
    assert.equal(read.props.props.profile?.fullName, 'Owner')
    assert.equal(
      (await otherBrowser.props('/settings/profile')).props.props.profile?.fullName,
      'Other'
    )

    const missingProof = await ownerBrowser.request('/settings/profile', {
      fullName: 'Changed',
      userId: String(other.id),
    })
    assert.equal(missingProof.status, 302)
    assert.equal((await User.findOrFail(owner.id)).fullName, 'Owner')
    const invalidName = await ownerBrowser.request('/settings/profile', {
      fullName: ' ',
      currentPassword,
    })
    assert.equal(invalidName.status, 302)
    assert.equal((await User.findOrFail(owner.id)).fullName, 'Owner')
    const wrongPassword = await ownerBrowser.request('/settings/profile', {
      fullName: 'Changed',
      currentPassword: 'WrongPass123!',
    })
    assert.equal(wrongPassword.status, 302)
    assert.equal((await User.findOrFail(owner.id)).fullName, 'Owner')
    const saved = await ownerBrowser.request('/settings/profile', {
      fullName: 'Changed',
      currentPassword,
      userId: String(other.id),
    })
    assert.equal(saved.status, 302)
    assert.equal((await User.findOrFail(owner.id)).fullName, 'Changed')
    assert.equal((await User.findOrFail(other.id)).fullName, 'Other')
  })

  test('email request stays pending, confirmation consumes once, and old sessions end', async ({
    assert,
  }) => {
    const owner = await User.create({
      id: 2001,
      fullName: 'Owner',
      email: 'owner@example.test',
      password: currentPassword,
    })
    const other = await User.create({
      id: 2002,
      fullName: 'Other',
      email: 'other@example.test',
      password: currentPassword,
    })
    const first = new BrowserSession()
    const second = new BrowserSession()
    const unrelated = new BrowserSession()
    await first.login(owner)
    await second.login(owner)
    await unrelated.login(other)
    const notify = (
      kit as unknown as {
        deps: {
          config: { notify: { emailChangeProvision: (...args: unknown[]) => Promise<void> } }
        }
      }
    ).deps.config.notify
    const original = notify.emailChangeProvision
    let confirmationUrl = ''
    notify.emailChangeProvision = async (...args: unknown[]) => {
      confirmationUrl = String(args[2])
    }
    try {
      const requested = await first.request('/settings/email', {
        email: 'new@example.test',
        currentPassword,
        userId: String(other.id),
      })
      assert.equal(requested.status, 302)
    } finally {
      notify.emailChangeProvision = original
    }
    assert.isTrue(Boolean(confirmationUrl))
    const pending = await User.findOrFail(owner.id)
    assert.equal(pending.email, 'owner@example.test')
    assert.equal(pending.unverifiedEmail, 'new@example.test')
    assert.equal((await User.verifyCredentials('owner@example.test', currentPassword)).id, owner.id)
    await assert.rejects(() => User.verifyCredentials('new@example.test', currentPassword))
    assert.equal((await User.findOrFail(other.id)).email, 'other@example.test')
    const path = new URL(confirmationUrl).pathname
    const inspect = await unrelated.props(path)
    assert.equal(inspect.status, 200)
    assert.equal(inspect.props.props.valid, true)
    assert.equal(inspect.props.props.user?.id, other.id)
    assert.equal((await unrelated.props(path)).props.props.valid, true)
    const completed = await unrelated.request(path, {})
    assert.equal(completed.status, 302)
    assert.include(completed.headers.get('location')!, '/login')
    assert.equal((await User.findOrFail(owner.id)).email, 'new@example.test')
    assert.equal((await User.verifyCredentials('new@example.test', currentPassword)).id, owner.id)
    await assert.rejects(() => User.verifyCredentials('owner@example.test', currentPassword))
    assert.equal((await unrelated.props(path)).props.props.valid, false)
    const replay = await unrelated.request(path, {})
    assert.equal(replay.status, 302)
    assert.equal((await User.findOrFail(owner.id)).email, 'new@example.test')
    for (const browser of [first, second, unrelated]) {
      assert.include((await browser.request('/dashboard')).headers.get('location')!, '/login')
    }
  })

  test('duplicate target is refused with generic copy', async ({ assert }) => {
    const owner = await User.create({
      id: 3001,
      fullName: 'Owner',
      email: 'owner@example.test',
      password: currentPassword,
    })
    await User.create({
      id: 3002,
      fullName: 'Other',
      email: 'other@example.test',
      password: currentPassword,
    })
    const browser = new BrowserSession()
    await browser.login(owner)
    const duplicate = await browser.request('/settings/email', {
      email: 'other@example.test',
      currentPassword,
    })
    assert.equal(duplicate.status, 302)
    assert.equal((await User.findOrFail(owner.id)).unverifiedEmail, null)
    const result = await browser.props('/settings/email')
    assert.include(JSON.stringify(result.props), 'This address cannot be used.')
    assert.notInclude(JSON.stringify(result.props), 'already registered')
  })

  test('an unconfirmed account must verify its current address before requesting a change', async ({
    assert,
  }) => {
    const owner = await User.create({
      id: 3501,
      fullName: 'Owner',
      email: 'owner@example.test',
      unverifiedEmail: 'owner@example.test',
      password: currentPassword,
    })
    const browser = new BrowserSession()
    await browser.login(owner)
    const page = await browser.props('/settings/email')
    assert.equal(page.props.props.canRequestChange, false)
    const response = await browser.request('/settings/email', {
      email: 'new@example.test',
      currentPassword,
    })
    assert.equal(response.status, 302)
    assert.equal((await User.findOrFail(owner.id)).email, 'owner@example.test')
    assert.equal((await User.findOrFail(owner.id)).unverifiedEmail, 'owner@example.test')
    assert.notExists(
      await db.from('email_verification_tokens').where('tokenable_id', owner.id).first()
    )
  })

  test('owner can cancel pending address with fresh proof and invalidate its link', async ({
    assert,
  }) => {
    const owner = await User.create({
      id: 4001,
      fullName: 'Owner',
      email: 'owner@example.test',
      password: currentPassword,
    })
    const browser = new BrowserSession()
    await browser.login(owner)
    const withoutProof = await browser.request('/settings/email', { email: 'new@example.test' })
    assert.equal(withoutProof.status, 302)
    assert.equal((await User.findOrFail(owner.id)).unverifiedEmail, null)
    const notification = (
      kit as unknown as {
        deps: {
          config: { notify: { emailChangeProvision: (...args: unknown[]) => Promise<void> } }
        }
      }
    ).deps.config.notify
    const original = notification.emailChangeProvision
    let confirmationUrl = ''
    notification.emailChangeProvision = async (...args: unknown[]) => {
      confirmationUrl = String(args[2])
    }
    try {
      const requested = await browser.request('/settings/email', {
        email: 'new@example.test',
        currentPassword,
      })
      assert.equal(requested.status, 302)
    } finally {
      notification.emailChangeProvision = original
    }
    assert.equal((await User.findOrFail(owner.id)).unverifiedEmail, 'new@example.test')
    const proofPath = new URL(confirmationUrl).pathname
    assert.equal((await browser.props(proofPath)).props.props.valid, true)
    const noProof = await browser.request('/settings/email/cancel', { cancelCurrentPassword: '' })
    assert.equal(noProof.status, 302)
    assert.equal((await User.findOrFail(owner.id)).unverifiedEmail, 'new@example.test')
    const canceled = await browser.request('/settings/email/cancel', {
      cancelCurrentPassword: currentPassword,
    })
    assert.equal(canceled.status, 302)
    assert.equal((await User.findOrFail(owner.id)).unverifiedEmail, null)
    assert.equal((await browser.props(proofPath)).props.props.valid, false)
  })

  test('requesting the confirmed address does not silently cancel a pending change', async ({
    assert,
  }) => {
    const owner = await User.create({
      id: 4501,
      fullName: 'Owner',
      email: 'owner@example.test',
      password: currentPassword,
    })
    const browser = new BrowserSession()
    await browser.login(owner)
    const notify = (
      kit as unknown as {
        deps: {
          config: { notify: { emailChangeProvision: (...args: unknown[]) => Promise<void> } }
        }
      }
    ).deps.config.notify
    const original = notify.emailChangeProvision
    let confirmationUrl = ''
    notify.emailChangeProvision = async (...args: unknown[]) => {
      confirmationUrl = String(args[2])
    }
    try {
      await browser.request('/settings/email', { email: 'new@example.test', currentPassword })
    } finally {
      notify.emailChangeProvision = original
    }
    const unchanged = await browser.request('/settings/email', {
      email: 'owner@example.test',
      currentPassword,
    })
    assert.equal(unchanged.status, 302)
    assert.equal((await User.findOrFail(owner.id)).unverifiedEmail, 'new@example.test')
    assert.include(
      JSON.stringify((await browser.props('/settings/email')).props),
      'Enter a different address.'
    )
    assert.equal((await browser.props(new URL(confirmationUrl).pathname)).props.props.valid, true)
  })

  test('a committed confirmation notice failure still ends the current browser session', async ({
    assert,
  }) => {
    const owner = await User.create({
      id: 5001,
      fullName: 'Owner',
      email: 'owner@example.test',
      password: currentPassword,
    })
    const other = await User.create({
      id: 5002,
      fullName: 'Other',
      email: 'other@example.test',
      password: currentPassword,
    })
    const requester = new BrowserSession()
    const completingBrowser = new BrowserSession()
    await requester.login(owner)
    await completingBrowser.login(other)
    const notify = (
      kit as unknown as {
        deps: {
          config: {
            notify: {
              emailChangeProvision: (...args: unknown[]) => Promise<void>
              emailChanged: (...args: unknown[]) => Promise<void>
            }
          }
        }
      }
    ).deps.config.notify
    const oldProvision = notify.emailChangeProvision
    const oldChanged = notify.emailChanged
    let confirmationUrl = ''
    notify.emailChangeProvision = async (...args: unknown[]) => {
      confirmationUrl = String(args[2])
    }
    try {
      await requester.request('/settings/email', { email: 'new@example.test', currentPassword })
    } finally {
      notify.emailChangeProvision = oldProvision
    }
    notify.emailChanged = async () => {
      throw new Error('simulated notice failure')
    }
    try {
      const response = await completingBrowser.request(new URL(confirmationUrl).pathname, {})
      assert.equal(response.status, 302)
      assert.include(response.headers.get('location')!, '/login')
    } finally {
      notify.emailChanged = oldChanged
    }
    assert.equal((await User.findOrFail(owner.id)).email, 'new@example.test')
    assert.include(
      (await completingBrowser.request('/dashboard')).headers.get('location')!,
      '/login'
    )
    assert.equal((await User.findOrFail(other.id)).email, 'other@example.test')
  })
})
