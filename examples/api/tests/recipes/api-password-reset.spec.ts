/* eslint-disable @unicorn/no-await-expression-member, @unicorn/filename-case -- Keep HTTP assertions beside requests and the filename aligned with the recipe selector. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'
import { captureNotifications } from 'adonisjs-account-kit/testing/notifications'
import type { ResolvedConfig } from 'adonisjs-account-kit/types'
import User from '#models/user'

const resetPath = '/account-kit/auth/password-reset'
const originalPassword = 'OriginalPass123!'
const replacementPassword = 'ReplacementPass123!'

test.group('API password reset recipe', () => {
  test('the original login and both bearer credentials obey the complete reset lifecycle', async ({
    client,
    assert,
  }) => {
    const capture = captureNotifications()
    const config = app.config.get<ResolvedConfig>('account_kit')
    const previous = { ...config.notify }
    Object.assign(config.notify, capture.notify)
    try {
      const user = await User.create({
        fullName: 'Recipe Owner',
        email: `recipe-${randomUUID()}@example.test`,
        password: originalPassword,
      })
      const login = async (password: string) =>
        client.post('/api/v1/auth/login').json({ email: user.email, password })
      const tokens: string[] = []
      for (let index = 0; index < 2; index++) {
        const response = await login(originalPassword)
        assert.equal(response.status(), 200)
        const body = response.body() as { data: { token: string } }
        assert.isString(body.data.token)
        tokens.push(body.data.token)
      }
      const credentialsHaveStatus = async (status: number) => {
        for (const token of tokens) {
          assert.equal(
            (await client.get('/api/v1/account/profile').bearerToken(token)).status(),
            status
          )
        }
      }
      assert.notEqual(tokens[0], tokens[1])
      await credentialsHaveStatus(200)
      await user.refresh()
      let savedHash = user.password
      const unchanged = async () => {
        await user.refresh()
        assert.equal(user.password, savedHash)
        await credentialsHaveStatus(200)
      }
      const requestProof = async () => {
        // This lifecycle checks proofs, not the independent request-throttling policy.
        await limiter.clear(['memory'])
        const response = await client.post(resetPath).json({ email: user.email })
        assert.equal(response.status(), 202)
        return capture.tokenFor('passwordResetProvision', user.email)
      }
      const submit = (token: string, confirmation = replacementPassword) =>
        client.post(`${resetPath}/${encodeURIComponent(token)}`).json({
          password: replacementPassword,
          passwordConfirmation: confirmation,
        })

      const first = await client.post(resetPath).json({ email: user.email })
      const unknown = await client
        .post(resetPath)
        .json({ email: `missing-${randomUUID()}@example.test` })
      assert.equal(first.status(), 202)
      assert.equal(unknown.status(), 202)
      assert.deepEqual(first.body(), unknown.body())
      const proof = capture.tokenFor('passwordResetProvision', user.email)
      for (let index = 0; index < 2; index++) {
        const inspection = await client.get(`${resetPath}/${encodeURIComponent(proof)}`)
        assert.equal(inspection.status(), 200)
        assert.deepEqual(inspection.body(), { valid: true })
      }
      assert.equal((await submit(proof, 'DifferentPass123!')).status(), 422)
      await unchanged()
      assert.equal((await submit('not-a-proof')).status(), 400)
      await unchanged()

      // P8: insert a past-expiry fixture; each account has only one proof row.
      await db.from('password_reset_tokens').where('tokenable_id', user.id).delete()
      const expired = randomBytes(40).toString('base64url')
      await db.table('password_reset_tokens').insert({
        tokenable_id: user.id,
        email: user.email,
        hash: createHash('sha256').update(expired).digest('hex'),
        created_at: new Date(Date.now() - 7200000).toISOString(),
        expires_at: new Date(Date.now() - 3600000).toISOString(),
      })
      assert.equal((await submit(expired)).status(), 400)
      await unchanged()

      const previousProof = await requestProof()
      assert.equal(
        (await client.get(`${resetPath}/${encodeURIComponent(previousProof)}`)).status(),
        200
      )
      const replacement = await requestProof()
      assert.notEqual(replacement, previousProof)
      assert.equal((await submit(previousProof)).status(), 400)
      await unchanged()
      const completion = await submit(replacement)
      assert.equal(completion.status(), 200)
      assert.deepEqual(completion.body(), { reset: true })
      await credentialsHaveStatus(401)
      assert.equal((await login(originalPassword)).status(), 400)
      assert.equal((await login(replacementPassword)).status(), 200)

      // A consumed proof must preserve credentials issued after the completed reset too.
      tokens.length = 0
      for (let index = 0; index < 2; index++) {
        const response = await login(replacementPassword)
        assert.equal(response.status(), 200)
        tokens.push((response.body() as { data: { token: string } }).data.token)
      }
      assert.notEqual(tokens[0], tokens[1])
      await user.refresh()
      savedHash = user.password
      assert.equal((await submit(replacement)).status(), 400)
      await unchanged()
    } finally {
      Object.assign(config.notify, previous)
    }
  })

  test('a mixed-case native signup can sign in and request a reset', async ({ client, assert }) => {
    const capture = captureNotifications()
    const config = app.config.get<ResolvedConfig>('account_kit')
    const previous = { ...config.notify }
    Object.assign(config.notify, capture.notify)
    try {
      const email = `Signup-${randomUUID()}@Example.test`
      const signup = await client.post('/api/v1/auth/signup').json({
        fullName: 'New Recipe Account',
        email,
        password: originalPassword,
        passwordConfirmation: originalPassword,
      })
      assert.equal(signup.status(), 200)
      assert.equal(
        (
          await client.post('/api/v1/auth/login').json({ email, password: originalPassword })
        ).status(),
        200
      )
      await limiter.clear(['memory'])
      assert.equal((await client.post(resetPath).json({ email })).status(), 202)
      assert.isString(capture.tokenFor('passwordResetProvision', email.toLowerCase()))
    } finally {
      Object.assign(config.notify, previous)
    }
  })
})
