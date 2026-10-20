import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import User from '#models/user'

test.group('reset proof browser journey', (group) => {
  group.each.setup(async () => {
    const truncate = await testUtils.db().truncate()
    await db.table('account_transaction_lock').insert({ id: 1, version: 0 })
    return truncate
  })

  test('a different signed-in account can inspect, complete, and replay an emailed reset link', async ({
    visit,
    assert,
  }) => {
    const owner = await User.create({
      fullName: 'Proof Owner',
      email: 'browser-owner@example.test',
      password: 'OldPass123!',
    })
    const other = await User.create({
      fullName: 'Other User',
      email: 'browser-other@example.test',
      password: 'OldPass123!',
    })
    const token = randomBytes(40).toString('base64url')
    const now = new Date()
    await db.table('password_reset_tokens').insert({
      tokenable_id: owner.id,
      email: owner.email,
      hash: createHash('sha256').update(token).digest('hex'),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 3600000).toISOString(),
    })

    const page = await visit('/login')
    await page.getByLabel('Email').fill(other.email)
    await page.getByLabel('Password').fill('OldPass123!')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()

    await page.goto(new URL(`/reset-password/${token}`, process.env.APP_URL).href)
    await page.getByRole('heading', { name: 'Choose a new password' }).waitFor()
    await page.goto(new URL('/dashboard', process.env.APP_URL).href)
    await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()

    await page.goto(new URL(`/reset-password/${token}`, process.env.APP_URL).href)
    await page.getByLabel('New password', { exact: true }).fill('ReplacementPass123!')
    await page.getByLabel('Confirm new password').fill('ReplacementPass123!')
    await page.getByRole('button', { name: 'Reset password' }).click()
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
    await page.goto(new URL(`/reset-password/${token}`, process.env.APP_URL).href)
    await page.getByRole('heading', { name: 'This link can’t be used' }).waitFor()
    const resetOwner = await User.verifyCredentials(owner.email, 'ReplacementPass123!')
    const unchangedOther = await User.verifyCredentials(other.email, 'OldPass123!')
    assert.equal(resetOwner.id, owner.id)
    assert.equal(unchangedOther.id, other.id)
  })
})
