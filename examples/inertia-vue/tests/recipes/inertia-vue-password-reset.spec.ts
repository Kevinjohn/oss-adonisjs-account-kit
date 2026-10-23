/* eslint-disable @unicorn/no-await-expression-member, @unicorn/filename-case -- Keep browser assertions beside each native form action and match the recipe selector. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import type { ResolvedConfig } from 'adonisjs-account-kit/types'
import User from '#models/user'

const originalPassword = 'OriginalPass123!'
const replacementPassword = 'ReplacementPass123!'

test.group('Inertia Vue password reset recipe', (group) => {
  group.each.setup(async () => {
    const cleanup = await testUtils.db().truncate()
    await db
      .table('account_transaction_lock')
      .insert({ id: 1, version: 0 })
      .onConflict('id')
      .ignore()
    return cleanup
  })

  test('the original login and two browser sessions obey the complete reset lifecycle', async ({
    visit,
    browser,
    assert,
  }) => {
    const email = `recipe-${randomUUID()}@example.test`
    const owner = await User.create({ fullName: 'Recipe Owner', email, password: originalPassword })
    const originalHash = owner.password
    const notify = app.config.get<ResolvedConfig>('account_kit').notify
    const previousNotify = notify.passwordResetProvision
    const resetUrls: string[] = []
    notify.passwordResetProvision = async (_user, url) => {
      resetUrls.push(url)
    }

    const secondContext = await browser.newContext({ baseURL: process.env.APP_URL })
    const requesterContext = await browser.newContext({ baseURL: process.env.APP_URL })
    const submitProof = async (path: string) => {
      await requesterContext.initiateSession()
      await requesterContext.request.get(path)
      const csrfCookie = (await requesterContext.cookies()).find(
        (cookie) => cookie.name === 'XSRF-TOKEN'
      )
      assert.exists(csrfCookie)
      const response = await requesterContext.request.post(path, {
        maxRedirects: 0,
        form: {
          password: 'AnotherPassword123!',
          passwordConfirmation: 'AnotherPassword123!',
        },
        headers: {
          'x-xsrf-token': decodeURIComponent(csrfCookie!.value),
          'referer': new URL(path, process.env.APP_URL).href,
        },
      })
      assert.equal(response.status(), 302)
    }
    try {
      const first = await visit('/login')
      const second = await secondContext.visit('/login')
      for (const page of [first, second]) {
        await page.getByLabel('Email').fill(email)
        await page.getByLabel('Password').fill(originalPassword)
        await page.getByRole('button', { name: 'Sign in' }).click()
        await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
        const protectedPage = await page.goto('/dashboard')
        assert.equal(protectedPage?.status(), 200)
        await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      }

      const assertOldCredentialsAndSessionsUnchanged = async () => {
        await owner.refresh()
        assert.equal(owner.password, originalHash)
        assert.equal((await User.verifyCredentials(email, originalPassword)).id, owner.id)
        for (const page of [first, second]) {
          const protectedPage = await page.goto('/dashboard')
          assert.equal(protectedPage?.status(), 200)
          await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
        }
      }

      await first.goto('/reset-password/not-a-proof')
      await first.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
      await submitProof('/reset-password/not-a-proof')
      await assertOldCredentialsAndSessionsUnchanged()

      const expiredToken = randomBytes(40).toString('base64url')
      const now = new Date()
      await db.table('password_reset_tokens').insert({
        tokenable_id: owner.id,
        email: owner.email,
        hash: createHash('sha256').update(expiredToken).digest('hex'),
        created_at: new Date(now.getTime() - 7200000).toISOString(),
        expires_at: new Date(now.getTime() - 3600000).toISOString(),
      })
      await first.goto(`/reset-password/${expiredToken}`)
      await first.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
      await submitProof(`/reset-password/${expiredToken}`)
      await assertOldCredentialsAndSessionsUnchanged()

      const requester = await requesterContext.visit('/forgot-password')
      const requestLink = async () => {
        await requester.getByLabel('Email').fill(email)
        await requester.getByRole('button', { name: 'Send reset link' }).click()
        await requester
          .getByText('If an account exists for that address, we have sent a reset link.')
          .waitFor()
        assert.isAbove(resetUrls.length, 0)
        return new URL(resetUrls.at(-1)!).pathname
      }
      const firstProofPath = await requestLink()
      await requester.goto('/forgot-password')
      const replacementProofPath = await requestLink()
      assert.notEqual(replacementProofPath, firstProofPath)
      await first.goto(firstProofPath)
      await first.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
      await submitProof(firstProofPath)
      await assertOldCredentialsAndSessionsUnchanged()

      await first.goto(replacementProofPath)
      await first.getByRole('heading', { name: 'Choose a new password' }).waitFor()
      await first.getByLabel('New password', { exact: true }).fill(replacementPassword)
      await first.getByLabel('Confirm new password').fill('DifferentPass123!')
      await first.getByRole('button', { name: 'Reset password' }).click()
      await first.getByRole('alert').waitFor()
      assert.equal(await first.getByLabel('New password', { exact: true }).inputValue(), '')
      assert.equal(await first.getByLabel('Confirm new password').inputValue(), '')
      await assertOldCredentialsAndSessionsUnchanged()

      await first.goto(replacementProofPath)
      await first.getByRole('heading', { name: 'Choose a new password' }).waitFor()
      await first.getByLabel('New password', { exact: true }).fill(replacementPassword)
      await first.getByLabel('Confirm new password').fill(replacementPassword)
      await first.getByRole('button', { name: 'Reset password' }).click()
      await first.getByRole('heading', { name: 'Welcome back' }).waitFor()
      for (const page of [first, second]) {
        await page.goto('/dashboard')
        assert.equal(new URL(page.url()).pathname, '/login')
      }

      await first.goto('/login')
      await first.getByLabel('Email').fill(email)
      await first.getByLabel('Password').fill(originalPassword)
      await first.getByRole('button', { name: 'Sign in' }).click()
      await first.getByText('Invalid email or password.').waitFor()
      assert.equal(new URL(first.url()).pathname, '/login')
      await assert.rejects(() => User.verifyCredentials(email, originalPassword))

      await first.getByLabel('Email').fill(email)
      await first.getByLabel('Password').fill(replacementPassword)
      await first.getByRole('button', { name: 'Sign in' }).click()
      await first.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      await second.goto('/login')
      await second.getByLabel('Email').fill(email)
      await second.getByLabel('Password').fill(replacementPassword)
      await second.getByRole('button', { name: 'Sign in' }).click()
      await second.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      const currentSessions = async () => {
        for (const page of [first, second]) {
          assert.equal((await page.goto('/dashboard'))?.status(), 200)
          assert.equal(new URL(page.url()).pathname, '/dashboard')
        }
      }
      await currentSessions()
      const replacementHash = (await User.findOrFail(owner.id)).password

      await first.goto(replacementProofPath)
      await first.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
      await first.getByRole('link', { name: 'Request a new link' }).waitFor()
      await owner.refresh()
      assert.equal((await User.verifyCredentials(email, replacementPassword)).id, owner.id)
      assert.equal(owner.password, replacementHash)
      await currentSessions()

      await submitProof(replacementProofPath)
      await owner.refresh()
      assert.equal(owner.password, replacementHash)
      assert.equal((await User.verifyCredentials(email, replacementPassword)).id, owner.id)
      await currentSessions()
    } finally {
      notify.passwordResetProvision = previousNotify
      await requesterContext.close()
      await secondContext.close()
    }
  })

  test('native signup with a mixed-case address keeps its session', async ({ visit, assert }) => {
    const email = `Signup-${randomUUID()}@Example.test`
    const page = await visit('/signup')
    await page.getByLabel('Full name').fill('New Recipe Account')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill(replacementPassword)
    await page.getByLabel('Confirm password').fill(replacementPassword)
    await page.getByRole('button', { name: 'Create account' }).click()
    await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
    assert.equal((await page.goto('/dashboard'))?.status(), 200)
    assert.equal(new URL(page.url()).pathname, '/dashboard')
    assert.equal(
      (await User.findByOrFail('email', email.toLowerCase())).fullName,
      'New Recipe Account'
    )
  })
})
