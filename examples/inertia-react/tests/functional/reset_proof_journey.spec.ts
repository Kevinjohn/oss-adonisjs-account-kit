/* eslint-disable @unicorn/no-await-expression-member -- Inline responses keep each assertion tied to the HTTP operation it verifies. */

import User from '#models/user'
import {
  HttpSession,
  origin,
  page,
  password,
  proofFor,
  replayPassword,
} from '#tests/helpers/functional_reset_proof_journey'
import { errors as authErrors } from '@adonisjs/auth'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { notifyOverrides } from '../../config/account_kit.js'
import { setupAccountDatabase } from '../helpers/account_database.js'

test.group('reset proof HTTP journey', (group) => {
  group.each.setup(setupAccountDatabase)

  test('a guest inspects a valid proof without consuming it and completes once', async ({
    assert,
  }) => {
    const owner = await User.create({
      fullName: 'Proof Owner',
      email: 'owner@example.test',
      password: 'OldPass123!',
    })
    const proof = await proofFor(owner)
    const session = new HttpSession()
    assert.equal((await page(session, proof.path)).body.props.valid, true)
    assert.equal((await page(session, proof.path)).body.props.valid, true)
    assert.exists(await db.from('password_reset_tokens').where('hash', proof.hash).first())

    const done = await session.request(proof.path, { password, passwordConfirmation: password })
    assert.equal(done.status, 302)
    assert.include(done.headers.get('location')!, '/login')
    assert.notExists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
    assert.equal((await page(session, proof.path)).body.props.valid, false)
  })

  for (const sameAccount of [true, false]) {
    test(`a signed-in ${sameAccount ? 'owner' : 'different user'} keeps identity during inspection then signs out on completion`, async ({
      assert,
    }) => {
      const owner = await User.create({
        fullName: 'Proof Owner',
        email: `owner-${sameAccount}@example.test`,
        password: 'OldPass123!',
      })
      const other = await User.create({
        fullName: 'Other User',
        email: `other-${sameAccount}@example.test`,
        password: 'OldPass123!',
      })
      const signedIn = sameAccount ? owner : other
      const proof = await proofFor(owner)
      const session = new HttpSession()
      assert.equal((await session.login(signedIn)).status, 302)
      const inspect = await page(session, proof.path)
      assert.equal(inspect.status, 200)
      assert.equal(inspect.body.props.valid, true)
      assert.equal(inspect.body.props.user?.id, signedIn.id)
      assert.exists(await db.from('password_reset_tokens').where('hash', proof.hash).first())

      const done = await session.request(proof.path, { password, passwordConfirmation: password })
      assert.equal(done.status, 302)
      assert.include(done.headers.get('location')!, '/login')
      assert.notExists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
      assert.equal((await page(session, proof.path)).body.props.valid, false)
      const dashboard = await session.request('/dashboard')
      assert.include(dashboard.headers.get('location')!, '/login')

      assert.equal((await User.verifyCredentials(owner.email, password)).id, owner.id)
      await assert.rejects(
        () => User.verifyCredentials(owner.email, 'OldPass123!'),
        authErrors.E_INVALID_CREDENTIALS
      )
      if (!sameAccount) {
        assert.equal((await User.verifyCredentials(other.email, 'OldPass123!')).id, other.id)
        await assert.rejects(
          () => User.verifyCredentials(other.email, password),
          authErrors.E_INVALID_CREDENTIALS
        )
      }

      const replay = await session.request(proof.path, {
        password: replayPassword,
        passwordConfirmation: replayPassword,
      })
      assert.equal(replay.status, 302)
      assert.equal(new URL(replay.headers.get('location')!, origin).pathname, '/forgot-password')
      assert.equal((await User.verifyCredentials(owner.email, password)).id, owner.id)
      await assert.rejects(
        () => User.verifyCredentials(owner.email, replayPassword),
        authErrors.E_INVALID_CREDENTIALS
      )
      if (!sameAccount) {
        assert.equal((await User.verifyCredentials(other.email, 'OldPass123!')).id, other.id)
        await assert.rejects(
          () => User.verifyCredentials(other.email, replayPassword),
          authErrors.E_INVALID_CREDENTIALS
        )
      }
    })
  }

  test('malformed and expired proofs render invalid without consuming unrelated proof', async ({
    assert,
  }) => {
    const owner = await User.create({
      fullName: 'Proof Owner',
      email: 'expired@example.test',
      password: 'OldPass123!',
    })
    const expired = await proofFor(owner, true)
    const session = new HttpSession()
    assert.equal((await page(session, '/reset-password/not-a-proof')).body.props.valid, false)
    assert.equal((await page(session, expired.path)).body.props.valid, false)
    assert.exists(await db.from('password_reset_tokens').where('hash', expired.hash).first())
  })

  test('signup and login remain guest-only for an authenticated browser', async ({ assert }) => {
    const user = await User.create({
      fullName: 'Signed In',
      email: 'signed-in@example.test',
      password: 'OldPass123!',
    })
    const session = new HttpSession()
    assert.equal((await session.login(user)).status, 302)
    for (const path of ['/signup', '/login']) {
      const response = await session.request(path)
      assert.equal(response.status, 302)
      assert.equal(new URL(response.headers.get('location')!, origin).pathname, '/')
    }
  })

  test('a committed notification failure still ends a different account session', async ({
    assert,
  }) => {
    const owner = await User.create({
      fullName: 'Proof Owner',
      email: 'notice-owner@example.test',
      password: 'OldPass123!',
    })
    const other = await User.create({
      fullName: 'Other User',
      email: 'notice-other@example.test',
      password: 'OldPass123!',
    })
    const proof = await proofFor(owner)
    const session = new HttpSession()
    assert.equal((await session.login(other)).status, 302)

    const notify = notifyOverrides
    const previous = notify.passwordResetCompleted
    notify.passwordResetCompleted = async () => {
      throw new Error('simulated notification failure')
    }
    try {
      const done = await session.request(proof.path, { password, passwordConfirmation: password })
      assert.equal(done.status, 302)
      assert.include(done.headers.get('location')!, '/login')
    } finally {
      notify.passwordResetCompleted = previous
    }

    assert.notExists(await db.from('password_reset_tokens').where('hash', proof.hash).first())
    assert.equal((await page(session, proof.path)).body.props.valid, false)
    assert.include((await session.request('/dashboard')).headers.get('location')!, '/login')
  })
})
