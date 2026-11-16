/* eslint-disable @unicorn/no-await-expression-member -- Keep each assertion next to the operation it inspects. */

import { DateTime, Settings } from 'luxon'
import { test } from '@japa/runner'
import { replaceBootstrapInvitation } from '../src/bootstrap_invitation.js'
import { withInvitationEvidence } from '../src/admission/invitation_evidence.js'
import { transaction } from '../src/db.js'
import {
  CapabilityDisabledError,
  EmailAlreadyRegisteredError,
  InvalidInputError,
} from '../src/errors.js'
import type { Invitation } from '../src/types.js'
import { locksRows } from './helpers/dialect.js'
import { createBarrier, startWithBackendId, waitForBlockedBy } from './helpers/lock_coordination.js'
import { dbTime } from './helpers/db_time.js'
import { useAdmissionApp } from './helpers/admission_schema.js'
import { allRequirements, makeAdmission, writeAdmissionRow } from './helpers/admission.js'
import { insertUser, tokenFrom } from './helpers/fakes.js'

test.group('admission bootstrap', (group) => {
  const kit = useAdmissionApp(group)

  const setup = () =>
    makeAdmission(kit, allRequirements, { onInvitationAccepted: withInvitationEvidence() })

  const waiting = () => kit.db.from('account_admissions').whereNull('user_id')

  const operatorInvitation = (email: string, inviterId: number | null, id = 99): Invitation => ({
    id,
    email,
    scope: null,
    role: 'owner',
    inviterId,
    expiresAt: DateTime.utc().plus({ days: 1 }),
    createdAt: DateTime.utc(),
    updatedAt: DateTime.utc(),
  })

  test('the accepted link lands the new account admitted', async ({ assert }) => {
    const { account, admission } = setup()
    const result = await admission.operator.bootstrap({
      email: ' Boss@Example.TEST ',
      role: 'owner',
    })
    assert.equal(result.invitation.email, 'boss@example.test')
    assert.isNull(result.invitation.inviterId)
    assert.isString(result.url)
    const [pending] = await waiting()
    assert.equal(pending.bootstrap_email, 'boss@example.test')
    assert.equal(pending.approval_status, 'approved')
    assert.equal(pending.invitation_id, result.invitation.id)

    const user = await account.invitations.accept({
      token: tokenFrom(result.url),
      password: 'ownerPassword1',
    })
    assert.isTrue(await admission.isAdmitted(user.id))
    const row = await kit.db.from('account_admissions').where('user_id', user.id).first()
    assert.deepEqual(
      [row.invitation_source, row.invited_role, row.approval_status, row.approval_actor_id],
      ['invitation', 'owner', 'approved', null]
    )
    assert.isNull(row.bootstrap_email)
    assert.lengthOf(await waiting(), 0)
    assert.lengthOf(await kit.db.from('account_admissions'), 1)
  })

  test('only the invitation the bootstrap issued attaches, matched at sign-in or not', async ({
    assert,
  }) => {
    const { admission } = setup()
    const issued = await admission.operator.bootstrap({ email: 'boss@example.test', role: 'owner' })
    const evidence = withInvitationEvidence()

    const member = await insertUser(kit, { email: 'boss@example.test' })
    await transaction(kit.db, (trx) =>
      evidence(member, operatorInvitation('boss@example.test', 7), trx)
    )
    assert.isFalse(await admission.isAdmitted(member.id))
    assert.lengthOf(await waiting(), 1)

    // A member invitation kept after its inviter was deleted has no inviter either.
    await kit.db.from('account_admissions').where('user_id', member.id).delete()
    await transaction(kit.db, (trx) =>
      evidence(member, operatorInvitation('boss@example.test', null), trx)
    )
    assert.isFalse(await admission.isAdmitted(member.id))
    assert.lengthOf(await waiting(), 1)

    await kit.db.from('account_admissions').where('user_id', member.id).delete()
    await transaction(kit.db, (trx) =>
      evidence(member, operatorInvitation('boss@example.test', null, issued.invitation.id), trx)
    )
    assert.isTrue(await admission.isAdmitted(member.id))
    assert.lengthOf(await waiting(), 0)
  })

  test('a second bootstrap replaces the approval; cancel deletes it', async ({ assert }) => {
    const { admission } = setup()
    await admission.operator.bootstrap({ email: 'boss@example.test', role: 'owner' })
    await admission.operator.bootstrap({ email: 'boss@example.test', role: 'admin' })
    assert.lengthOf(await waiting(), 1)
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
    assert.isTrue(await admission.operator.cancelBootstrap({ email: 'BOSS@example.test' }))
    assert.lengthOf(await waiting(), 0)
    assert.isFalse(await admission.operator.cancelBootstrap({ email: 'boss@example.test' }))
  })

  test('a bootstrap whose approval vanished while inviting prints no link', async ({ assert }) => {
    const { admission } = makeAdmission(kit, allRequirements, {
      onInvitationAccepted: withInvitationEvidence(),
      // Stands in for a concurrent cancel or second bootstrap while the invitation is issued.
      onLifecycleEvent: async (event) => {
        if (event.type === 'invitation.sent')
          await kit.db.from('account_admissions').whereNull('user_id').delete()
      },
    })
    await assert.rejects(
      () => admission.operator.bootstrap({ email: 'boss@example.test', role: 'owner' }),
      /replaced or cancelled/
    )
  })

  test('list and decisions never see a waiting approval', async ({ assert }) => {
    const { admission } = setup()
    // Listing needs an admitted actor; its row sorts last so it never hides the order under test.
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    await writeAdmissionRow(kit, actor.id, { invited: true, approval: 'approved' })
    await kit.db
      .from('account_admissions')
      .where('user_id', actor.id)
      .update({ created_at: dbTime(kit, DateTime.utc().plus({ days: 1 })) })
    await admission.operator.bootstrap({ email: 'boss@example.test', role: 'owner' })
    const emails = (page: { items: Array<{ email: string }> }) => page.items.map((i) => i.email)
    assert.deepEqual(emails(await admission.list({ actorId: actor.id })), [actor.email])
    assert.deepEqual(emails(await admission.list({ actorId: actor.id, status: 'approved' })), [
      actor.email,
    ])
    // The waiting row is older than the account's row, yet the first page of one holds the account.
    const person = await insertUser(kit, { email: 'person@example.test' })
    await admission.operator.approve({ email: person.email })
    const page = await admission.list({ actorId: actor.id, limit: 1 })
    assert.deepEqual(emails(page), [person.email])
    const next = await admission.list({ actorId: actor.id, limit: 1, cursor: page.nextCursor! })
    assert.deepEqual(emails(next), [actor.email])
    assert.isNull(next.nextCursor)
  })

  test('an account that already has a record keeps it and leaves the waiting approval', async ({
    assert,
  }) => {
    const { admission } = setup()
    await admission.operator.bootstrap({ email: 'boss@example.test', role: 'owner' })
    const user = await insertUser(kit, { email: 'boss@example.test' })
    await kit.db.table('account_admissions').insert({
      user_id: user.id,
      requested_at: dbTime(kit),
      created_at: dbTime(kit),
      updated_at: dbTime(kit),
    })
    await transaction(kit.db, (trx) =>
      withInvitationEvidence()(user, operatorInvitation('boss@example.test', null), trx)
    )
    const row = await kit.db.from('account_admissions').where('user_id', user.id).first()
    assert.equal(row.invitation_source, 'invitation')
    assert.isNull(row.approval_status)
    assert.lengthOf(await waiting(), 1)
  })

  test('refuses a registered address, a bad role or address, and writes nothing', async ({
    assert,
  }) => {
    const { admission } = setup()
    await admission.operator.bootstrap({ email: 'taken@example.test', role: 'owner' })
    await insertUser(kit, { email: 'taken@example.test' })
    await assert.rejects(
      () => admission.operator.bootstrap({ email: 'taken@example.test', role: 'owner' }),
      EmailAlreadyRegisteredError
    )
    for (const input of [
      { email: 'boss@example.test', role: '' },
      { email: 'boss@example.test', role: 'x'.repeat(65) },
      { email: 'not-an-email', role: 'owner' },
    ])
      await assert.rejects(() => admission.operator.bootstrap(input), InvalidInputError)
    // The earlier waiting approval for the taken address is left as it was.
    assert.deepEqual(
      (await kit.db.from('account_admissions')).map((row) => row.bootstrap_email),
      ['taken@example.test']
    )
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
  })

  test('the sent observer sees the committed matching invitation and approval', async ({
    assert,
  }) => {
    let paired = false
    const { admission } = makeAdmission(kit, allRequirements, {
      onLifecycleEvent: async (event) => {
        if (event.type !== 'invitation.sent') return
        const pending = await waiting().first()
        const invitation = await kit.db
          .from('account_invitations')
          .where('id', event.invitationId)
          .first()
        paired = pending?.invitation_id === invitation?.id
      },
    })
    await admission.operator.bootstrap({ email: 'boss@example.test', role: 'owner' })
    assert.isTrue(paired)
  })

  test('overlapping bootstraps expose only the surviving committed pair', async ({ assert }) => {
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    let committedPairVisible = false
    const { admission, account } = makeAdmission(kit, allRequirements, {
      onInvitationAccepted: withInvitationEvidence(),
      onLifecycleEvent: async (event) => {
        if (event.type !== 'invitation.sent' || !first) return
        first = false
        const pending = await waiting().first()
        const invitation = await kit.db
          .from('account_invitations')
          .where('id', event.invitationId)
          .first()
        committedPairVisible = pending?.invitation_id === invitation.id
        enter()
        await held
      },
    })
    const earlier = admission.operator.bootstrap({ email: 'boss@example.test', role: 'owner' })
    const rejected = assert.rejects(() => earlier, /replaced or cancelled/)
    try {
      await entered
      assert.isTrue(committedPairVisible)
      const later = await admission.operator.bootstrap({
        email: 'boss@example.test',
        role: 'admin',
      })
      assert.equal((await waiting().first()).invitation_id, later.invitation.id)
      release()
      await rejected
      const user = await account.invitations.accept({
        token: tokenFrom(later.url),
        password: 'ownerPassword1',
      })
      assert.isTrue(await admission.isAdmitted(user.id))
      assert.lengthOf(await kit.db.from('account_admissions'), 1)
    } finally {
      release()
    }
  })

  test('an approval database failure rolls back replacement and emits no event', async ({
    assert,
  }) => {
    const events: string[] = []
    const { admission, account, config } = makeAdmission(kit, allRequirements, {
      onInvitationAccepted: withInvitationEvidence(),
      onLifecycleEvent: async (event) => {
        events.push(event.type)
      },
    })
    const original = await admission.operator.bootstrap({
      email: 'boss@example.test',
      role: 'owner',
    })
    const prior = await waiting().first()
    events.length = 0
    const find = config.users.findByEmail.bind(config.users)
    config.users.findByEmail = async (email, trx) => {
      const user = await find(email, trx)
      if (trx) {
        const table = trx.table.bind(trx)
        trx.table = ((name: string) => {
          const builder = table(name)
          if (name === 'account_admissions') {
            const insert = builder.insert.bind(builder)
            builder.insert = ((row: object) =>
              insert({ ...row, missing_approval_column: true })) as typeof builder.insert
          }
          return builder
        }) as typeof trx.table
      }
      return user
    }
    try {
      await assert.rejects(
        () => admission.operator.bootstrap({ email: 'boss@example.test', role: 'admin' }),
        /missing_approval_column/
      )
    } finally {
      config.users.findByEmail = find
    }
    assert.deepEqual(await waiting().first(), prior)
    assert.equal((await kit.db.from('account_invitations').first()).id, original.invitation.id)
    assert.deepEqual(events, [])
    const user = await account.invitations.accept({
      token: tokenFrom(original.url),
      password: 'ownerPassword1',
    })
    assert.isTrue(await admission.isAdmitted(user.id))
  })
  test('a committed observer failure returns the usable link and ordinary operator fault', async ({
    assert,
  }) => {
    const { admission, account } = makeAdmission(kit, allRequirements, {
      onInvitationAccepted: withInvitationEvidence(),
      onLifecycleEvent: async (event) => {
        if (event.type === 'invitation.sent') throw new Error('observer unavailable')
      },
    })
    const issued = await admission.operator.bootstrap({ email: 'boss@example.test', role: 'owner' })
    assert.equal(issued.fault?.name, 'PostCommitError')
    const user = await account.invitations.accept({
      token: tokenFrom(issued.url),
      password: 'ownerPassword1',
    })
    assert.isTrue(await admission.isAdmitted(user.id))
  })

  test('the invitation capability gate prevents bootstrap writes', async ({ assert }) => {
    const { admission } = makeAdmission(kit, allRequirements, { enabled: [] })
    await assert.rejects(
      () => admission.operator.bootstrap({ email: 'boss@example.test', role: 'owner' }),
      CapabilityDisabledError
    )
    assert.lengthOf(await waiting(), 0)
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
  })

  test('an account registered after the precheck prevents replacement under the invitation lock', async ({
    assert,
  }) => {
    const { admission, config } = setup()
    const issued = await admission.operator.bootstrap({ email: 'boss@example.test', role: 'owner' })
    const prior = await waiting().first()
    const find = config.users.findByEmail.bind(config.users)
    let registered = false
    config.users.findByEmail = async (email, trx) => {
      const found = await find(email, trx)
      if (!trx && !registered) {
        registered = true
        await insertUser(kit, { email })
      }
      return found
    }
    try {
      await assert.rejects(
        () => admission.operator.bootstrap({ email: 'boss@example.test', role: 'admin' }),
        EmailAlreadyRegisteredError
      )
    } finally {
      config.users.findByEmail = find
    }
    assert.deepEqual(await waiting().first(), prior)
    assert.equal((await kit.db.from('account_invitations').first()).id, issued.invitation.id)
  })

  for (const existing of [false, true]) {
    test(`issues a fresh lifetime after the locked eligibility check for an ${existing ? 'existing' : 'absent'} key`, async ({
      assert,
    }) => {
      const { admission, account, config } = makeAdmission(kit, allRequirements, {
        expiresIn: { invitation: 1 },
      })
      if (existing) await admission.operator.bootstrap({ email: 'boss@example.test', role: 'old' })
      const originalClock = Settings.now
      let clock = Math.floor(Date.now() / 1000) * 1000
      Settings.now = () => clock
      const find = config.users.findByEmail.bind(config.users)
      config.users.findByEmail = async (email, trx) => {
        const user = await find(email, trx)
        if (trx) clock += 2_000
        return user
      }
      try {
        const issued = await admission.operator.bootstrap({
          email: 'boss@example.test',
          role: 'owner',
        })
        assert.equal(issued.invitation.createdAt.toMillis(), Math.floor(clock / 1000) * 1000)
        assert.equal(
          issued.invitation.expiresAt.toMillis(),
          Math.floor(clock / 1000) * 1000 + 1_000
        )
        assert.isNotNull(await account.invitations.inspect({ token: tokenFrom(issued.url) }))
      } finally {
        Settings.now = originalClock
        config.users.findByEmail = find
      }
    })
  }

  test('a conflicting token cannot reserve another invitation address', async ({ assert }) => {
    const { config } = setup()
    const token = 'a'.repeat(64)
    const original = await transaction(kit.db, (trx) =>
      replaceBootstrapInvitation(config, trx, {
        email: 'first@example.test',
        role: 'owner',
        token,
      })
    )
    await assert.rejects(() =>
      transaction(kit.db, (trx) =>
        replaceBootstrapInvitation(config, trx, {
          email: 'second@example.test',
          role: 'admin',
          token,
        })
      )
    )
    const rows = await kit.db.from('account_invitations')
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].id, original.id)
    assert.equal(rows[0].email, 'first@example.test')
    assert.equal(rows[0].role, 'owner')
  })

  if (locksRows) {
    for (const existing of [false, true]) {
      test(`serializes overlapping writers for an ${existing ? 'existing' : 'absent'} invitation key`, async ({
        assert,
      }) => {
        const { admission, account, config } = setup()
        if (existing)
          await admission.operator.bootstrap({ email: 'boss@example.test', role: 'old' })
        const reserved = createBarrier('first bootstrap reservation')
        let release!: () => void
        const hold = new Promise<void>((resolve) => {
          release = resolve
        })
        const find = config.users.findByEmail.bind(config.users)
        let first = true
        config.users.findByEmail = async (email, trx) => {
          if (trx && first) {
            first = false
            reserved.signal()
            await hold
          }
          return find(email, trx)
        }
        const earlier = startWithBackendId(kit, () =>
          admission.operator.bootstrap({ email: 'boss@example.test', role: 'owner' })
        )
        reserved.observe(earlier.operation)
        let later: Promise<Awaited<typeof earlier.operation>> | undefined
        try {
          await reserved.promise
          later = admission.operator.bootstrap({ email: 'boss@example.test', role: 'admin' })
          void later.catch(() => {})
          await waitForBlockedBy(kit, assert, await earlier.backendId)
          release()
          await earlier.operation
          const issued = await later
          assert.equal((await waiting().first()).invitation_id, issued.invitation.id)
          assert.lengthOf(await kit.db.from('account_invitations'), 1)
          const user = await account.invitations.accept({
            token: tokenFrom(issued.url),
            password: 'ownerPassword1',
          })
          assert.isTrue(await admission.isAdmitted(user.id))
        } finally {
          release()
          config.users.findByEmail = find
          await Promise.allSettled([earlier.operation, ...(later ? [later] : [])])
        }
      })
    }
  }
})
