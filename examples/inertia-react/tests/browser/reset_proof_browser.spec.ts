import { test } from '@japa/runner'
import { createProofFor } from '../helpers/account_proof.js'
import User from '#models/user'
import { setupAccountDatabase } from '../helpers/account_database.js'

test.group('reset proof browser journey', (group) => {
  group.each.setup(setupAccountDatabase)

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
    const { token } = await createProofFor(owner, 'reset-password')

    const page = await visit('/login')
    await page.getByLabel('Email').fill(other.email)
    await page.getByLabel('Password', { exact: true }).fill('OldPass123!')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()

    await page.goto(new URL(`/reset-password/${token}`, process.env.APP_URL).href)
    await page.getByRole('heading', { name: 'Choose a new password' }).waitFor()
    await page.goto(new URL('/dashboard', process.env.APP_URL).href)
    await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()

    const proofResponse = await page.goto(
      new URL(`/reset-password/${token}`, process.env.APP_URL).href
    )
    assert.equal(proofResponse!.headers()['cache-control'], 'no-store')
    assert.equal(proofResponse!.headers()['referrer-policy'], 'no-referrer')
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
