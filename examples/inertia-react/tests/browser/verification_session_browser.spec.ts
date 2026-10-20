import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import User from '#models/user'
import kit from 'adonisjs-account-kit/services/main'

async function proofFor(owner: User) {
  const token = randomBytes(40).toString('base64url')
  const now = new Date()
  await db.table('email_verification_tokens').insert({
    tokenable_id: owner.id,
    email: owner.email,
    current_email: owner.email,
    purpose: 'activation',
    hash: createHash('sha256').update(token).digest('hex'),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 3600000).toISOString(),
  })
  return token
}

test.group('verification session browser journey', (group) => {
  group.each.setup(async () => {
    const truncate = await testUtils.db().truncate()
    await db.table('account_transaction_lock').insert({ id: 1, version: 0 })
    return truncate
  })

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
      const token = await proofFor(owner)

      const page = await visit('/login')
      if (identity !== 'guest') {
        const signedIn = identity === 'same account' ? owner : other
        await page.getByLabel('Email').fill(signedIn.email)
        await page.getByLabel('Password').fill('OldPass123!')
        await page.getByRole('button', { name: 'Sign in' }).click()
        await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
      }

      await page.goto(new URL(`/verify-email/${token}`, process.env.APP_URL).href)
      await page.getByLabel('Password', { exact: true }).fill('NewPass123!')
      await page.getByLabel('Confirm password').fill('NewPass123!')
      await page.getByRole('button', { name: 'Confirm email' }).click()
      await page.getByRole('heading', { name: 'Welcome back' }).waitFor()

      await page.getByLabel('Email').fill(owner.email)
      await page.getByLabel('Password').fill('NewPass123!')
      await page.getByRole('button', { name: 'Sign in' }).click()
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
    const token = await proofFor(owner)
    const page = await visit('/login')
    await page.getByLabel('Email').fill(owner.email)
    await page.getByLabel('Password').fill('OldPass123!')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()

    const config = (
      kit as unknown as {
        deps: { config: { onCredentialsChanged?: () => Promise<void> } }
      }
    ).deps.config
    const previous = config.onCredentialsChanged
    let followUpFailed = false
    config.onCredentialsChanged = async () => {
      followUpFailed = true
      throw new Error('simulated follow-up failure')
    }
    try {
      await page.goto(new URL(`/verify-email/${token}`, process.env.APP_URL).href)
      await page.getByLabel('Password', { exact: true }).fill('NewPass123!')
      await page.getByLabel('Confirm password').fill('NewPass123!')
      await page.getByRole('button', { name: 'Confirm email' }).click()
      await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
    } finally {
      config.onCredentialsChanged = previous
    }
    assert.isTrue(followUpFailed)

    await page.getByLabel('Email').fill(owner.email)
    await page.getByLabel('Password').fill('NewPass123!')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('heading', { name: 'Your dashboard is ready' }).waitFor()
    const signedInOwner = await User.verifyCredentials(owner.email, 'NewPass123!')
    assert.equal(signedInOwner.id, owner.id)
  })
})
