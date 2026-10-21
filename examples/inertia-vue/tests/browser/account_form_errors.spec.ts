import { createHash, randomBytes } from 'node:crypto'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { setupAccountDatabase } from '../helpers/account_database.js'

test.group('account form errors', (group) => {
  group.each.setup(setupAccountDatabase)

  test('plain HTML validation flashes safe signup input but no camelCase password fields', async ({
    browser,
    assert,
  }) => {
    const context = await browser.newContext({ baseURL: process.env.APP_URL })
    try {
      await context.initiateSession()
      await context.request.get('/signup')
      const cookies = await context.cookies()
      const csrfCookie = cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')
      assert.exists(csrfCookie)

      const response = await context.request.post('/signup', {
        maxRedirects: 0,
        form: {
          fullName: 'Ada Lovelace',
          email: 'ada@example.test',
          password: 'SensitivePass123!',
          passwordConfirmation: 'DifferentPass123!',
        },
        headers: {
          'x-xsrf-token': decodeURIComponent(csrfCookie!.value),
          'referer': new URL('/signup', process.env.APP_URL).href,
        },
      })

      assert.equal(response.status(), 302)
      const flash = await context.getFlashMessages()
      assert.equal(flash.fullName, 'Ada Lovelace')
      assert.equal(flash.email, 'ada@example.test')
      assert.notInclude(JSON.stringify(flash), 'SensitivePass123!')
      assert.notInclude(JSON.stringify(flash), 'DifferentPass123!')
    } finally {
      await context.close()
    }
  })

  test('signup announces a confirmation mismatch and focuses useful feedback without losing input', async ({
    visit,
    assert,
  }) => {
    const page = await visit('/signup')
    await page.setViewportSize({ width: 1440, height: 900 })
    assert.isAtMost(
      await page.evaluate(
        () =>
          (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } })
            .document.documentElement.scrollWidth
      ),
      await page.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth)
    )
    await page.getByLabel('Full name').fill('Ada Lovelace')
    await page.getByLabel('Email').fill('ada@example.test')
    await page.getByLabel('Password', { exact: true }).fill('Password123!')
    await page.getByLabel('Confirm password').fill('Different123!')
    assert.isNull(await page.getByLabel('Confirm password').getAttribute('aria-invalid'))
    await page.getByRole('button', { name: 'Create account' }).focus()
    await page.keyboard.press('Enter')

    const summary = page.getByRole('alert')
    await summary.waitFor()
    assert.include(await summary.ariaSnapshot(), 'Confirm password')
    assert.equal(
      await summary.evaluate(
        (element) =>
          (element as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement ===
          element
      ),
      true
    )
    const confirmation = page.getByLabel('Confirm password')
    assert.equal(await confirmation.getAttribute('aria-invalid'), 'true')
    assert.equal(
      await confirmation.getAttribute('aria-describedby'),
      'signup-passwordConfirmation-error'
    )
    assert.match(
      await page.locator('#signup-passwordConfirmation-error').innerText(),
      /confirm password/i
    )
    assert.notInclude(
      await page.locator('#signup-passwordConfirmation-error').innerText(),
      'passwordConfirmation'
    )
    assert.exists(
      await summary.getByRole('link', { name: 'Confirm password' }).getAttribute('href')
    )
    assert.equal(await page.getByLabel('Full name').inputValue(), 'Ada Lovelace')
    assert.equal(await page.getByLabel('Email').inputValue(), 'ada@example.test')
    assert.equal(await page.getByLabel('Password', { exact: true }).inputValue(), '')
    assert.equal(await confirmation.inputValue(), '')

    await page.setViewportSize({ width: 375, height: 812 })
    assert.isAtMost(
      await page.evaluate(
        () =>
          (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } })
            .document.documentElement.scrollWidth
      ),
      await page.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth)
    )

    await page.keyboard.press('Tab')
    const summaryLink = summary.getByRole('link', { name: 'Confirm password' })
    assert.equal(
      await summaryLink.evaluate(
        (element) =>
          (element as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement ===
          element
      ),
      true
    )
    await page.keyboard.press('Enter')
    assert.equal(
      await confirmation.evaluate(
        (element) =>
          (element as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement ===
          element
      ),
      true
    )
    await page.getByLabel('Password', { exact: true }).fill('Password123!')
    await confirmation.fill('StillDifferent123!')
    await page.getByRole('button', { name: 'Create account' }).focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() =>
      (
        globalThis as unknown as {
          document: { activeElement: { hasAttribute(name: string): boolean } }
        }
      ).document.activeElement.hasAttribute('data-form-error-summary')
    )
    assert.equal(
      await summary.evaluate(
        (element) =>
          (element as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement ===
          element
      ),
      true
    )
  })

  test('reset clears password fields after error and associates the confirmation message', async ({
    visit,
    assert,
  }) => {
    const user = await User.create({
      fullName: 'Reset User',
      email: 'reset@example.test',
      password: 'OldPass123!',
    })
    const token = randomBytes(40).toString('base64url')
    const now = new Date()
    await db.table('password_reset_tokens').insert({
      tokenable_id: user.id,
      email: user.email,
      hash: createHash('sha256').update(token).digest('hex'),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 3600000).toISOString(),
    })
    const page = await visit(`/reset-password/${token}`)
    await page.getByLabel('New password', { exact: true }).fill('Replacement123!')
    await page.getByLabel('Confirm new password').fill('Different123!')
    assert.isNull(await page.getByLabel('Confirm new password').getAttribute('aria-invalid'))
    await page.getByRole('button', { name: 'Reset password' }).focus()
    await page.keyboard.press('Enter')

    const summary = page.getByRole('alert')
    await summary.waitFor()
    assert.include(await summary.ariaSnapshot(), 'Confirm new password')
    assert.equal(
      await summary.evaluate(
        (element) =>
          (element as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement ===
          element
      ),
      true
    )
    const confirmation = page.getByLabel('Confirm new password')
    assert.equal(await confirmation.getAttribute('aria-invalid'), 'true')
    assert.equal(
      await confirmation.getAttribute('aria-describedby'),
      'reset-passwordConfirmation-error'
    )
    assert.match(
      await page.locator('#reset-passwordConfirmation-error').innerText(),
      /confirm password/i
    )
    assert.notInclude(
      await page.locator('#reset-passwordConfirmation-error').innerText(),
      'passwordConfirmation'
    )
    assert.equal(await page.getByLabel('New password', { exact: true }).inputValue(), '')
    assert.equal(await confirmation.inputValue(), '')
  })

  test('profile validation errors clear the current password', async ({ visit, assert }) => {
    const user = await User.create({
      fullName: 'Profile User',
      email: 'profile@example.test',
      password: 'OldPass123!',
      emailVerifiedAt: DateTime.now(),
    })
    const page = await visit('/login')
    await page.getByLabel('Email').fill(user.email)
    await page.getByLabel('Password').fill('OldPass123!')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
    await page.goto('/settings/profile')
    await page.setViewportSize({ width: 375, height: 812 })
    assert.isAtMost(
      await page.evaluate(
        () =>
          (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } })
            .document.documentElement.scrollWidth
      ),
      await page.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth)
    )

    const invalidName = 'A'.repeat(256)
    await page.getByLabel('Full name').fill(invalidName)
    await page.getByLabel('Current password').fill('SensitivePass123!')
    await page.getByRole('button', { name: 'Save profile' }).click()
    await page.getByRole('alert').waitFor()

    assert.equal(await page.getByLabel('Current password').inputValue(), '')
  })
})
