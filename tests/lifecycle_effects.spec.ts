import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { DeliveryError, PostCommitError } from '../src/errors.js'
import { postCommit } from '../src/effects.js'
import { generateToken, hashToken } from '../src/tokens.js'
import type { CredentialChangeContext, LifecycleEvent } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeNotify, makeService, tokenFrom } from './helpers/fakes.js'

test.group('post-commit effects', () => {
  test('attempts every delivery and reports delivery-only failure', async ({ assert }) => {
    const events: string[] = []
    const first = new Error('first')
    const second = new Error('second')
    let failure: unknown
    try {
      await postCommit('delivery failed', [
        {
          kind: 'delivery',
          run: async () => {
            events.push('one')
            throw first
          },
        },
        {
          kind: 'delivery',
          run: async () => {
            events.push('two')
            throw second
          },
        },
      ])
    } catch (error) {
      failure = error
    }
    assert.instanceOf(failure, DeliveryError)
    assert.deepEqual(events, ['one', 'two'])
    assert.deepEqual(
      (failure as DeliveryError).cause instanceof AggregateError
        ? ((failure as DeliveryError).cause as AggregateError).errors
        : [],
      [first, second]
    )
  })

  test('an observer failure makes mixed follow-ups a committed-change error', async ({
    assert,
  }) => {
    const delivery = new Error('delivery')
    const observer = new Error('observer')
    let failure: unknown
    try {
      await postCommit('follow-up failed', [
        {
          kind: 'delivery',
          run: async () => {
            throw delivery
          },
        },
        {
          kind: 'observer',
          run: async () => {
            throw observer
          },
        },
      ])
    } catch (error) {
      failure = error
    }
    assert.instanceOf(failure, PostCommitError)
    assert.deepEqual(
      (failure as PostCommitError).cause instanceof AggregateError
        ? ((failure as PostCommitError).cause as AggregateError).errors
        : [],
      [delivery, observer]
    )
  })
})

test.group('credential and lifecycle effects', (group) => {
  const kit = useTestApp(group)

  test('transactional password revocation rolls back with the password, then commits with one notice and event', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const schema = kit.db.connection().schema
    await schema.dropTableIfExists('test_revocations')
    await schema.createTable('test_revocations', (table) => {
      table.increments('id')
      table.string('operation_id').notNullable()
    })
    const contexts: CredentialChangeContext[] = []
    const events: LifecycleEvent[] = []
    let fail = true
    const { account, recorder } = makeService(kit, {
      onCredentialsChangedTransaction: async (_changed, context, trx) => {
        contexts.push(context)
        await trx.table('test_revocations').insert({ operation_id: context.operationId })
        if (fail) throw new Error('revoke failed')
      },
      onLifecycleEvent: async (event) => {
        events.push(event)
      },
    })
    try {
      await assert.rejects(
        () =>
          account.emailPasswordManagement.changePassword({
            actorId: user.id,
            currentPassword: 'password123',
            newPassword: 'changedPassword123',
          }),
        /revoke failed/
      )
      assert.lengthOf(await kit.db.from('test_revocations'), 0)
      assert.lengthOf(recorder.calls, 0)
      assert.lengthOf(events, 0)
      const unchanged = await kit.db.from('users').where('id', user.id).first()
      assert.isTrue(await kit.hash.verify(unchanged.password, 'password123'))

      fail = false
      await account.emailPasswordManagement.changePassword({
        actorId: user.id,
        currentPassword: 'password123',
        newPassword: 'changedPassword123',
      })
      const rows = await kit.db.from('test_revocations')
      assert.lengthOf(rows, 1)
      assert.equal(contexts.at(-1)?.operation, 'password_change')
      assert.equal(contexts.at(-1)?.userId, user.id)
      assert.equal(rows[0].operation_id, contexts.at(-1)?.operationId)
      assert.deepEqual(
        recorder.calls.map((call) => call.method),
        ['passwordChanged']
      )
      assert.deepEqual(events, [
        { type: 'password.changed', userId: user.id, operationId: rows[0].operation_id },
      ])
    } finally {
      await schema.dropTableIfExists('test_revocations')
    }
  })

  test('reset hook failure restores the consumed token; success sends a dedicated notice', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const token = generateToken()
    await kit.db.table('password_reset_tokens').insert({
      user_id: user.id,
      email: user.email,
      token_hash: hashToken(token),
      expires_at: DateTime.utc().plus({ hours: 1 }).toISO(),
      created_at: DateTime.utc().toISO(),
    })
    let fail = true
    const events: LifecycleEvent[] = []
    const { account, recorder } = makeService(kit, {
      onCredentialsChangedTransaction: async () => {
        if (fail) throw new Error('revoke failed')
      },
      onLifecycleEvent: async (event) => {
        events.push(event)
      },
    })
    await assert.rejects(
      () => account.passwordReset.reset({ token, password: 'newPassword123' }),
      /revoke failed/
    )
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
    assert.lengthOf(recorder.calls, 0)
    fail = false
    await account.passwordReset.reset({ token, password: 'newPassword123' })
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
    assert.deepEqual(
      recorder.calls.map((call) => call.method),
      ['passwordResetCompleted']
    )
    assert.equal(events[0]?.type, 'password.reset')
  })

  test('post-commit failures run legacy callback, notice, and event in order after a committed password change', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const failures = [new Error('legacy'), new Error('notice'), new Error('listener')]
    const order: string[] = []
    const notify = makeNotify().notify
    const { account } = makeService(kit, {
      onCredentialsChanged: async (_changed, context) => {
        order.push(`legacy:${context.operationId}`)
        throw failures[0]
      },
      notify: {
        ...notify,
        passwordChanged: async (_changed, context) => {
          order.push(`notice:${context.operationId}`)
          throw failures[1]
        },
      },
      onLifecycleEvent: async (event) => {
        order.push(`event:${event.operationId}`)
        throw failures[2]
      },
    })
    let error: unknown
    try {
      await account.emailPasswordManagement.changePassword({
        actorId: user.id,
        currentPassword: 'password123',
        newPassword: 'changedPassword123',
      })
    } catch (caught) {
      error = caught
    }
    assert.instanceOf(error, PostCommitError)
    const cause = (error as PostCommitError).cause
    assert.instanceOf(cause, AggregateError)
    assert.deepEqual((cause as AggregateError).errors, failures)
    assert.deepEqual(
      order.map((entry) => entry.split(':')[0]),
      ['legacy', 'notice', 'event']
    )
    assert.equal(new Set(order.map((entry) => entry.split(':')[1])).size, 1)
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isTrue(await kit.hash.verify(row.password, 'changedPassword123'))
  })

  test('password reset issuance emits for a known account even if delivery fails, and not for an unknown account', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const events: LifecycleEvent[] = []
    const deliveryFailure = new Error('mail failed')
    const notify = makeNotify().notify
    const { account } = makeService(kit, {
      minRequestMs: 0,
      notify: {
        ...notify,
        passwordResetProvision: async () => {
          throw deliveryFailure
        },
      },
      onLifecycleEvent: async (event) => {
        events.push(event)
      },
    })
    await assert.rejects(
      () => account.passwordReset.request({ email: user.email, clientKey: 'client-one' }),
      DeliveryError
    )
    assert.deepEqual(
      events.map((event) => event.type),
      ['password_reset.requested']
    )
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
    await account.passwordReset.request({ email: 'missing@example.test', clientKey: 'client-two' })
    assert.lengthOf(events, 1)
  })

  test('verification emits once for the actual change, never on repeat', async ({ assert }) => {
    const user = await insertUser(kit, { verified: false })
    const token = kit.encryption.encrypt(
      { userId: user.id, email: user.email },
      '1h',
      'account-kit:verify-email'
    )
    const events: LifecycleEvent[] = []
    const { account } = makeService(kit, {
      onLifecycleEvent: async (event) => {
        events.push(event)
      },
    })
    assert.equal(await account.emailVerification.complete({ token }), 'verified')
    assert.equal(await account.emailVerification.complete({ token }), 'already_verified')
    assert.deepEqual(
      events.map((event) => event.type),
      ['verification.completed']
    )
  })

  test('email completion restores its token when transactional revocation fails', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account: requesting, recorder } = makeService(kit)
    await requesting.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'password123',
      newEmail: 'next@example.test',
    })
    const token = tokenFrom(recorder.calls[0].args[2])
    let fail = true
    const contexts: CredentialChangeContext[] = []
    const { account } = makeService(kit, {
      onCredentialsChangedTransaction: async (_changed, context) => {
        contexts.push(context)
        if (fail) throw new Error('revoke failed')
      },
    })
    await assert.rejects(
      () => account.emailPasswordManagement.completeEmailChange({ token }),
      /revoke failed/
    )
    assert.lengthOf(await kit.db.from('account_email_changes'), 1)
    const unchanged = await kit.db.from('users').where('id', user.id).first()
    assert.equal(unchanged.email, user.email)
    fail = false
    const changed = await account.emailPasswordManagement.completeEmailChange({ token })
    assert.equal(changed.email, 'next@example.test')
    assert.equal(contexts.at(-1)?.operation, 'email_change')
    assert.equal(contexts.at(-1)?.userId, user.id)
    assert.lengthOf(await kit.db.from('account_email_changes'), 0)
  })

  test('email request listener failure leaves a usable link and same-email proof emits no event', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const events: LifecycleEvent[] = []
    const listenerFailure = new Error('audit failed')
    const { account, recorder } = makeService(kit, {
      onLifecycleEvent: async (event) => {
        events.push(event)
        throw listenerFailure
      },
    })
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'password123',
      newEmail: user.email,
    })
    assert.lengthOf(events, 0)
    let failure: unknown
    try {
      await account.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword: 'password123',
        newEmail: 'next@example.test',
      })
    } catch (caught) {
      failure = caught
    }
    assert.instanceOf(failure, PostCommitError)
    assert.equal((failure as PostCommitError).cause, listenerFailure)
    assert.deepEqual(
      events.map((event) => event.type),
      ['email_change.requested']
    )
    assert.deepEqual(
      recorder.calls.map((call) => call.method),
      ['emailChangeProvision']
    )
    assert.lengthOf(await kit.db.from('account_email_changes'), 1)
  })

  test('reset notice still runs when legacy callback and lifecycle listener fail', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const token = generateToken()
    await kit.db.table('password_reset_tokens').insert({
      user_id: user.id,
      email: user.email,
      token_hash: hashToken(token),
      expires_at: DateTime.utc().plus({ hours: 1 }).toISO(),
      created_at: DateTime.utc().toISO(),
    })
    const first = new Error('legacy')
    const last = new Error('listener')
    const order: string[] = []
    const defaults = makeNotify().notify
    const { account } = makeService(kit, {
      notify: {
        ...defaults,
        passwordResetCompleted: async () => {
          order.push('notice')
        },
      },
      onCredentialsChanged: async () => {
        order.push('legacy')
        throw first
      },
      onLifecycleEvent: async () => {
        order.push('event')
        throw last
      },
    })
    let failure: unknown
    try {
      await account.passwordReset.reset({ token, password: 'newPassword123' })
    } catch (caught) {
      failure = caught
    }
    assert.instanceOf(failure, PostCommitError)
    assert.deepEqual(((failure as PostCommitError).cause as AggregateError).errors, [first, last])
    assert.deepEqual(order, ['legacy', 'notice', 'event'])
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
  })

  test('email completion attempts old-address notice and lifecycle listener after a failing legacy callback', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account: requesting, recorder } = makeService(kit)
    await requesting.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'password123',
      newEmail: 'next@example.test',
    })
    const token = tokenFrom(recorder.calls[0].args[2])
    const errors = [new Error('legacy'), new Error('notice'), new Error('listener')]
    const order: string[] = []
    const notify = makeNotify().notify
    const { account } = makeService(kit, {
      notify: {
        ...notify,
        emailChanged: async () => {
          order.push('notice')
          throw errors[1]
        },
      },
      onCredentialsChanged: async (_changed, context) => {
        assert.equal(context.operation, 'email_change')
        order.push('legacy')
        throw errors[0]
      },
      onLifecycleEvent: async (event) => {
        assert.equal(event.type, 'email_change.completed')
        order.push('event')
        throw errors[2]
      },
    })
    let failure: unknown
    try {
      await account.emailPasswordManagement.completeEmailChange({ token })
    } catch (caught) {
      failure = caught
    }
    assert.instanceOf(failure, PostCommitError)
    assert.deepEqual(((failure as PostCommitError).cause as AggregateError).errors, errors)
    assert.deepEqual(order, ['legacy', 'notice', 'event'])
    const changed = await kit.db.from('users').where('id', user.id).first()
    assert.equal(changed.email, 'next@example.test')
    assert.lengthOf(await kit.db.from('account_email_changes'), 0)
  })

  test('SQLite retry rolls back the first revocation and emits one committed event and notice', async ({
    assert,
  }) => {
    if (process.env.DB_CLIENT === 'pg') return
    const user = await insertUser(kit)
    const schema = kit.db.connection().schema
    await schema.dropTableIfExists('test_retry_revocations')
    await schema.createTable('test_retry_revocations', (table) => {
      table.increments('id')
      table.string('operation_id').notNullable()
    })
    let attempts = 0
    const ids: string[] = []
    const events: LifecycleEvent[] = []
    const { account, recorder } = makeService(kit, {
      onCredentialsChangedTransaction: async (_changed, context, trx) => {
        attempts++
        ids.push(context.operationId)
        await trx.table('test_retry_revocations').insert({ operation_id: context.operationId })
        if (attempts === 1) throw Object.assign(new Error('retry'), { code: 'SQLITE_BUSY' })
      },
      onLifecycleEvent: async (event) => {
        events.push(event)
      },
    })
    try {
      await account.emailPasswordManagement.changePassword({
        actorId: user.id,
        currentPassword: 'password123',
        newPassword: 'changedPassword123',
      })
      assert.equal(attempts, 2)
      assert.equal(new Set(ids).size, 1)
      const rows = await kit.db.from('test_retry_revocations')
      assert.lengthOf(rows, 1)
      assert.equal(rows[0].operation_id, ids[0])
      assert.deepEqual(
        recorder.calls.map((call) => call.method),
        ['passwordChanged']
      )
      assert.deepEqual(
        events.map((event) => event.type),
        ['password.changed']
      )
    } finally {
      await schema.dropTableIfExists('test_retry_revocations')
    }
  })
})
