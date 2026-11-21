import { test } from '@japa/runner'
import { createProofFor } from '../helpers/account_proof.js'
import User from '#models/user'
import { setupAccountDatabase } from '../helpers/account_database.js'
import { lifecycleOverrides } from '../../config/account_kit.js'

test.group('verification session browser journey', (group) => {
  group.each.setup(setupAccountDatabase)

  for (const identity of ['same account', 'different account', 'guest']) {
    test(`${identity} can confirm an email and sign in on the first attempt`, async ({
      visit,
      assert,
    }) => {
      const owner = await User.create({
        fullName: 'Proof Owner',
        email: `verification-owner-${identity.replace(' ', '-')}@example.test`,
        unverifiedEmail: `verification-owner-${identity.replace(' ', '-')}@example.test`,
        password: 'OldPass123!',
      })
      const other = await User.create({
        fullName: 'Other User',
        email: `verification-other-${identity.replace(' ', '-')}@example.test`,
        password: 'OldPass123!',
      })
      const { token } = await createProofFor(owner, 'verify-email')

      const page = await visit('/login')
      if (identity !== 'guest') {
        const signedIn = identity === 'same account' ? owner : other
        await page.getByLabel('Email').fill(signedIn.email)
        await page.getByLabel('Password', { exact: true }).fill('OldPass123!')
        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      }

      await page.goto(new URL(`/verify-email/${token}`, process.env.APP_URL).href)
      await page.getByLabel('Password', { exact: true }).fill('NewPass123!')
      await page.getByLabel('Confirm password').fill('NewPass123!')
      await page.getByRole('button', { name: 'Confirm email', exact: true }).click()
      await page.getByRole('heading', { name: 'Welcome back' }).waitFor()

      await page.getByLabel('Email').fill(owner.email)
      await page.getByLabel('Password', { exact: true }).fill('NewPass123!')
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      const signedInOwner = await User.verifyCredentials(owner.email, 'NewPass123!')
      assert.equal(signedInOwner.id, owner.id)
    })
  }

  test('a committed follow-up failure still ends the current browser before first login', async ({
    visit,
    assert,
  }) => {
    const owner = await User.create({
      fullName: 'Proof Owner',
      email: 'verification-follow-up@example.test',
      unverifiedEmail: 'verification-follow-up@example.test',
      password: 'OldPass123!',
    })
    const { token } = await createProofFor(owner, 'verify-email')
    const page = await visit('/login')
    await page.getByLabel('Email').fill(owner.email)
    await page.getByLabel('Password', { exact: true }).fill('OldPass123!')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()

    const previous = lifecycleOverrides.run
    let followUpFailed = false
    lifecycleOverrides.run = async (event) => {
      if ((event as { type?: string }).type !== 'verification.completed') return
      followUpFailed = true
      throw new Error('simulated follow-up failure')
    }
    try {
      await page.goto(new URL(`/verify-email/${token}`, process.env.APP_URL).href)
      await page.getByLabel('Password', { exact: true }).fill('NewPass123!')
      await page.getByLabel('Confirm password').fill('NewPass123!')
      await page.getByRole('button', { name: 'Confirm email', exact: true }).click()
      await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
    } finally {
      lifecycleOverrides.run = previous
    }
    assert.isTrue(followUpFailed)

    await page.getByLabel('Email').fill(owner.email)
    await page.getByLabel('Password', { exact: true }).fill('NewPass123!')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
    const signedInOwner = await User.verifyCredentials(owner.email, 'NewPass123!')
    assert.equal(signedInOwner.id, owner.id)
  })
})
