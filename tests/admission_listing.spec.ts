/* eslint-disable @unicorn/no-await-expression-member -- Keep each assertion next to the operation it inspects. */

import { test } from '@japa/runner'
import {
  E_ACCOUNT_KIT_INVALID_INPUT,
  E_ACCOUNT_KIT_ADMISSION_POLICY_DENIED,
  E_ACCOUNT_KIT_ADMISSION_ACTOR_NOT_ADMITTED,
} from '../src/errors.js'
import { useAdmissionApp } from './helpers/admission_schema.js'
import { allowDecisions, makeAdmission, writeAdmissionRow } from './helpers/admission.js'
import { insertUser, makeUsersAdapter } from './helpers/fakes.js'
import { dbTime } from './helpers/db_time.js'

const approvalOnly = { approval: { required: true as const, authorize: allowDecisions } }

test.group('admission listing', (group) => {
  const kit = useAdmissionApp(group)

  async function seed() {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    await writeAdmissionRow(kit, actor.id, { approval: 'approved' })
    const people = {
      pending: await insertUser(kit, { email: 'pending@example.test' }),
      silent: await insertUser(kit, { email: 'silent@example.test' }),
      approved: await insertUser(kit, { email: 'approved@example.test' }),
      rejected: await insertUser(kit, { email: 'rejected@example.test' }),
      revoked: await insertUser(kit, { email: 'revoked@example.test' }),
    }
    await writeAdmissionRow(kit, people.pending.id, { requested: true })
    await writeAdmissionRow(kit, people.silent.id, { invited: true })
    await writeAdmissionRow(kit, people.approved.id, { requested: true, approval: 'approved' })
    await writeAdmissionRow(kit, people.rejected.id, { approval: 'rejected' })
    await writeAdmissionRow(kit, people.revoked.id, { approval: 'revoked' })
    return { actor, people }
  }

  test('filters by status; pending means asked and undecided', async ({ assert }) => {
    const { actor, people } = await seed()
    const { admission } = makeAdmission(kit, approvalOnly)
    const emails = async (status?: 'pending' | 'approved' | 'rejected' | 'revoked') =>
      (await admission.list({ actorId: actor.id, status })).items.map((item) => item.email)
    assert.deepEqual(await emails('pending'), [people.pending.email])
    assert.deepEqual(await emails('approved'), [actor.email, people.approved.email])
    assert.deepEqual(await emails('rejected'), [people.rejected.email])
    assert.deepEqual(await emails('revoked'), [people.revoked.email])
    assert.sameMembers(await emails(), [
      actor.email,
      ...Object.values(people).map((person) => person.email),
    ])
    await assert.rejects(
      () => admission.list({ actorId: actor.id, status: 'archived' as never }),
      E_ACCOUNT_KIT_INVALID_INPUT
    )
  })

  test('returns an empty page when no records match the requested status', async ({ assert }) => {
    const actor = await insertUser(kit)
    await writeAdmissionRow(kit, actor.id, { approval: 'approved' })
    const { admission } = makeAdmission(kit, approvalOnly)
    assert.deepEqual(await admission.list({ actorId: actor.id, status: 'pending' }), {
      items: [],
      nextCursor: null,
    })
  })

  test('pages in creation order with a cursor and rejects a forged cursor', async ({ assert }) => {
    const { actor } = await seed()
    const { admission } = makeAdmission(kit, approvalOnly)
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await admission.list({ actorId: actor.id, limit: 2, cursor })
      seen.push(...page.items.map((item) => item.email))
      cursor = page.nextCursor ?? undefined
      pages++
    } while (cursor)
    assert.equal(pages, 3)
    assert.deepEqual(seen, [
      'actor@example.test',
      'pending@example.test',
      'silent@example.test',
      'approved@example.test',
      'rejected@example.test',
      'revoked@example.test',
    ])

    for (const bad of ['nope', Buffer.from('[1,2]').toString('base64url'), 'x'.repeat(600)])
      await assert.rejects(
        () => admission.list({ actorId: actor.id, cursor: bad }),
        'Invalid admission cursor'
      )
    for (const limit of [0, 101, 1.5])
      await assert.rejects(
        () => admission.list({ actorId: actor.id, limit }),
        E_ACCOUNT_KIT_INVALID_INPUT
      )
  })

  test('requires authorize.list to return exactly true', async ({ assert }) => {
    const { actor } = await seed()
    const calls: unknown[] = []
    const { admission } = makeAdmission(kit, {
      approval: {
        required: true,
        authorize: {
          decide: async () => true,
          list: async (listing) => {
            calls.push(listing.id)
            return 1 as never
          },
        },
      },
    })
    await assert.rejects(
      () => admission.list({ actorId: actor.id }),
      E_ACCOUNT_KIT_ADMISSION_POLICY_DENIED
    )
    assert.deepEqual(calls, [actor.id])
    await assert.rejects(() => admission.list({ actorId: 999_999 }), 'Unknown actor')
  })

  test('a revoked or undecided approver cannot list', async ({ assert }) => {
    const { actor } = await seed()
    const { admission } = makeAdmission(kit, approvalOnly)
    await writeAdmissionRow(kit, actor.id, { approval: 'revoked' })
    await assert.rejects(
      () => admission.list({ actorId: actor.id }),
      E_ACCOUNT_KIT_ADMISSION_ACTOR_NOT_ADMITTED
    )
    await kit.db.from('account_admissions').where('user_id', actor.id).delete()
    await assert.rejects(
      () => admission.list({ actorId: actor.id }),
      E_ACCOUNT_KIT_ADMISSION_ACTOR_NOT_ADMITTED
    )
  })

  test('pages rows that share a created_at by id', async ({ assert }) => {
    const { actor } = await seed()
    await kit.db
      .from('account_admissions')
      .update({ created_at: dbTime(kit, '2026-01-01T00:00:00Z') })
    const { admission } = makeAdmission(kit, approvalOnly)
    const first = await admission.list({ actorId: actor.id, limit: 2 })
    assert.isString(first.nextCursor)
    const second = await admission.list({ actorId: actor.id, limit: 2, cursor: first.nextCursor! })
    assert.lengthOf(second.items, 2)
  })

  test('skips a missing user at the page boundary and keeps the next cursor', async ({
    assert,
  }) => {
    const { actor, people } = await seed()
    const users = makeUsersAdapter(kit.db, kit.hash)
    // A user can disappear between fetching the admission page and resolving the account.
    const { admission } = makeAdmission(kit, approvalOnly, {
      users: {
        ...users,
        findById: async (id, trx) => (id === people.pending.id ? null : users.findById(id, trx)),
      },
    })

    const first = await admission.list({ actorId: actor.id, limit: 2 })
    assert.deepEqual(
      first.items.map((item) => item.email),
      [actor.email]
    )
    assert.isString(first.nextCursor)
    const second = await admission.list({ actorId: actor.id, limit: 2, cursor: first.nextCursor! })
    assert.deepEqual(
      second.items.map((item) => item.email),
      [people.silent.email, people.approved.email]
    )
  })
})
