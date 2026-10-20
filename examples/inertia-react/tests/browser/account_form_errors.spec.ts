import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import User from '#models/user'

test.group('account form errors', (group) => {
  group.each.setup(async () => {
    const truncate = await testUtils.db().truncate()
    await truncate()
    await db.table('account_transaction_lock').insert({ id: 1, version: 0 })
  })

  test('signup announces a confirmation mismatch and focuses useful feedback without losing input', async ({
    visit,
    assert,
  }) => {
    const page = await visit('/signup')
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

  test('reset associates its confirmation error and preserves the entered password', async ({
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
    assert.equal(
      await page.getByLabel('New password', { exact: true }).inputValue(),
      'Replacement123!'
    )
  })
})
