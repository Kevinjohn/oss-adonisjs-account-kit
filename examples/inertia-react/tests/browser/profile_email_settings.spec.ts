/* eslint-disable @unicorn/no-await-expression-member -- Keep each browser outcome beside its assertion. */
import { test } from '@japa/runner'
import User from '#models/user'
import kit from 'adonisjs-account-kit/services/main'
import { setupAccountDatabase } from '../helpers/account_database.js'

const password = 'OldPass123!'
const longEmail = `${'a'.repeat(64)}@example.test`

test.group('profile and email settings browser journey', (group) => {
  group.each.setup(setupAccountDatabase)

  test('two browsers save a profile, request a pending address, and complete its proof once', async ({
    visit,
    browser,
    assert,
  }) => {
    const owner = await User.create({
      id: 7001,
      fullName: 'Demo Owner',
      email: longEmail,
      password,
    })
    const other = await User.create({
      id: 7002,
      fullName: 'Demo Other',
      email: 'other@example.test',
      password,
    })
    const ownerPage = await visit('/login')
    const pageErrors: string[] = []
    ownerPage.on('pageerror', (error) => pageErrors.push(error.message))
    await ownerPage.getByLabel('Email').fill(owner.email)
    await ownerPage.getByLabel('Password').fill(password)
    await ownerPage.getByRole('button', { name: 'Sign in' }).click()
    await ownerPage.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()

    const otherContext = await browser.newContext({ baseURL: process.env.APP_URL })
    try {
      const otherPage = await otherContext.visit('/login')
      await otherPage.getByLabel('Email').fill(other.email)
      await otherPage.getByLabel('Password').fill(password)
      await otherPage.getByRole('button', { name: 'Sign in' }).click()
      await otherPage.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()

      await ownerPage.goto('/settings/profile')
      await ownerPage.getByLabel('Full name').fill('Updated Owner')
      await ownerPage.getByLabel('Current password').fill(password)
      await ownerPage.getByRole('button', { name: 'Save profile' }).click()
      await ownerPage.getByText('Your profile has been updated.').waitFor()
      assert.equal((await User.findOrFail(owner.id)).fullName, 'Updated Owner')

      await ownerPage.goto('/settings/email')
      await ownerPage.getByRole('heading', { name: 'Email', exact: true }).waitFor()
      await ownerPage.setViewportSize({ width: 320, height: 700 })
      assert.equal(await ownerPage.locator('main').count(), 1)
      assert.equal(await ownerPage.locator('h1').count(), 1)
      assert.equal(
        await ownerPage.evaluate(() => {
          const view = globalThis as unknown as {
            document: { documentElement: { scrollWidth: number } }
            innerWidth: number
          }
          return view.document.documentElement.scrollWidth <= view.innerWidth
        }),
        true
      )
      const notify = (
        kit as unknown as {
          deps: {
            config: {
              notify: {
                emailChangeProvision: (...args: unknown[]) => Promise<void>
              }
            }
          }
        }
      ).deps.config.notify
      const original = notify.emailChangeProvision
      const confirmationUrls: string[] = []
      notify.emailChangeProvision = async (...args: unknown[]) => {
        confirmationUrls.push(String(args[2]))
      }
      try {
        await ownerPage.getByLabel('New email address').fill('')
        await ownerPage.getByLabel('Current password').fill(password)
        await ownerPage.getByRole('button', { name: 'Request change' }).focus()
        await ownerPage.keyboard.press('Enter')
        const summary = ownerPage.getByRole('alert')
        await summary.waitFor()
        assert.include(await summary.ariaSnapshot(), 'New email address')
        assert.equal(
          await summary.evaluate(
            (element) =>
              (element as { ownerDocument: { activeElement: unknown } }).ownerDocument
                .activeElement === element
          ),
          true
        )
        await ownerPage.getByLabel('New email address').fill('new@example.test')
        await ownerPage.getByLabel('Current password').fill(password)
        await ownerPage.getByRole('button', { name: 'Request change' }).click()
        await ownerPage.getByText('Pending confirmation:').waitFor()
        await ownerPage.getByLabel('Current password').last().fill(password)
        await ownerPage.getByRole('button', { name: 'Cancel pending change' }).click()
        await ownerPage.getByText('Pending confirmation:').waitFor({ state: 'hidden' })
        await otherPage.goto(new URL(confirmationUrls[0]).pathname)
        await otherPage.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
        await ownerPage.getByLabel('New email address').fill('final@example.test')
        await ownerPage.getByLabel('Current password').fill(password)
        await ownerPage.getByRole('button', { name: 'Request change' }).click()
        await ownerPage.getByText('Pending confirmation:').waitFor()
      } finally {
        notify.emailChangeProvision = original
      }
      assert.equal((await User.findOrFail(owner.id)).email, longEmail)
      assert.equal((await User.findOrFail(owner.id)).unverifiedEmail, 'final@example.test')
      for (const width of [320, 768, 1024, 1440]) {
        await ownerPage.setViewportSize({ width, height: 700 })
        assert.equal(
          await ownerPage.evaluate(() => {
            const view = globalThis as unknown as {
              document: { documentElement: { scrollWidth: number } }
              innerWidth: number
            }
            return view.document.documentElement.scrollWidth <= view.innerWidth
          }),
          true
        )
      }

      const path = new URL(confirmationUrls[1]).pathname
      await otherPage.goto(path)
      await otherPage.getByRole('heading', { name: 'Confirm your new email' }).waitFor()
      await otherPage.goto('/dashboard')
      await otherPage.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      await otherPage.goto(path)
      await otherPage.getByRole('button', { name: 'Confirm email change' }).click()
      await otherPage.getByRole('heading', { name: 'Welcome back' }).waitFor()
      await otherPage.goto(path)
      await otherPage.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
      assert.equal((await User.findOrFail(owner.id)).email, 'final@example.test')
      assert.equal((await User.findOrFail(other.id)).email, 'other@example.test')
      await ownerPage.goto('/dashboard')
      await ownerPage.getByRole('heading', { name: 'Welcome back' }).waitFor()
      assert.deepEqual(pageErrors, [])
    } finally {
      await otherContext.close()
    }
  })
})
