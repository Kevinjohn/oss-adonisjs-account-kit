/* eslint-disable @unicorn/no-await-expression-member -- Keep each assertion next to the operation it inspects. */

import { test } from '@japa/runner'
import { AdmissionDecisionError } from '../src/admission/errors.js'
import { nextApprovalStatus, type AdmissionTransition } from '../src/admission/decisions.js'
import type { AdmissionEvent } from '../src/admission/types.js'
import { clientChallengeFor } from '../src/magic_link.js'
import {
  AuthorizationError,
  CapabilityDisabledError,
  InvalidInputError,
  PostCommitError,
  UserNotFoundError,
} from '../src/errors.js'
import type { AccountUser } from '../src/types.js'
import { useAdmissionApp } from './helpers/admission_schema.js'
import { allowDecisions, makeAdmission, writeAdmissionRow } from './helpers/admission.js'
import { credentialsFixtures } from './helpers/credentials.js'
import { insertUser, makeNotify, tokenFrom } from './helpers/fakes.js'
import { clientChallenge, provider } from './helpers/social_identity.js'

const approvalOnly = { approval: { required: true as const, authorize: allowDecisions } }
type Status = 'approved' | 'rejected' | 'revoked'

test.group('admission transitions', () => {
  test('follow the transition table and refuse every other cell', ({ assert }) => {
    const table: Record<string, Record<AdmissionTransition, Status | null>> = {
      none: { approve: 'approved', reject: 'rejected', revoke: null },
      approved: { approve: null, reject: null, revoke: 'revoked' },
      rejected: { approve: 'approved', reject: null, revoke: null },
      revoked: { approve: 'approved', reject: null, revoke: null },
    }
    for (const [from, row] of Object.entries(table))
      for (const [transition, expected] of Object.entries(row) as [
        AdmissionTransition,
        Status | null,
      ][]) {
        const start = from === 'none' ? null : (from as Status)
        if (expected) assert.equal(nextApprovalStatus(start, transition), expected)
        else assert.throws(() => nextApprovalStatus(start, transition), AdmissionDecisionError)
      }
  })
})

test.group('admission decisions', (group) => {
  const kit = useAdmissionApp(group)
  const { issueEmailChange } = credentialsFixtures(kit)

  async function owner(email = 'owner@example.test'): Promise<AccountUser> {
    const user = await insertUser(kit, { email })
    await writeAdmissionRow(kit, user.id, { approval: 'approved' })
    return user
  }
  const status = async (user: AccountUser) =>
    (await kit.db.from('account_admissions').where('user_id', user.id).first())?.approval_status ??
    null

  test('an admitted approver applies each allowed transition and records who decided', async ({
    assert,
  }) => {
    const events: AdmissionEvent[] = []
    const { admission } = makeAdmission(
      kit,
      { ...approvalOnly, onAdmissionEvent: async (event) => void events.push(event) },
      {}
    )
    const actor = await owner()
    const subject = await insertUser(kit, { email: 'subject@example.test' })

    const approved = await admission.approve({ actorId: actor.id, userId: subject.id })
    assert.equal(approved.approval?.status, 'approved')
    assert.equal(approved.approval?.actorId, actor.id)
    assert.equal(approved.email, 'subject@example.test')
    await assert.rejects(
      () => admission.approve({ actorId: actor.id, userId: subject.id }),
      AdmissionDecisionError
    )
    await assert.rejects(
      () => admission.reject({ actorId: actor.id, userId: subject.id }),
      AdmissionDecisionError
    )
    assert.equal(
      (await admission.revoke({ actorId: actor.id, userId: subject.id })).approval?.status,
      'revoked'
    )
    await assert.rejects(
      () => admission.revoke({ actorId: actor.id, userId: subject.id }),
      AdmissionDecisionError
    )
    assert.equal(
      (await admission.approve({ actorId: actor.id, userId: subject.id })).approval?.status,
      'approved'
    )

    const fresh = await insertUser(kit, { email: 'fresh@example.test' })
    await assert.rejects(
      () => admission.revoke({ actorId: actor.id, userId: fresh.id }),
      AdmissionDecisionError
    )
    assert.equal(
      (await admission.reject({ actorId: actor.id, userId: fresh.id })).approval?.status,
      'rejected'
    )
    assert.deepEqual(
      events.map((event) => [event.type, event.userId, 'actorId' in event ? event.actorId : null]),
      [
        ['admission.approved', subject.id, actor.id],
        ['admission.revoked', subject.id, actor.id],
        ['admission.approved', subject.id, actor.id],
        ['admission.rejected', fresh.id, actor.id],
      ]
    )
  })

  test('refuses self-decision, a non-admitted actor and a denying authorize', async ({
    assert,
  }) => {
    const actor = await owner()
    const subject = await insertUser(kit, { email: 'subject@example.test' })
    const { admission } = makeAdmission(kit, approvalOnly)
    await assert.rejects(
      () => admission.approve({ actorId: actor.id, userId: actor.id }),
      AuthorizationError
    )

    const pending = await insertUser(kit, { email: 'pending@example.test' })
    await assert.rejects(
      () => admission.approve({ actorId: pending.id, userId: subject.id }),
      AuthorizationError
    )
    await writeAdmissionRow(kit, actor.id, { approval: 'revoked' })
    await assert.rejects(
      () => admission.approve({ actorId: actor.id, userId: subject.id }),
      AuthorizationError
    )
    await writeAdmissionRow(kit, actor.id, { approval: 'approved' })

    const seen: unknown[] = []
    const { admission: denying } = makeAdmission(kit, {
      approval: {
        required: true,
        authorize: {
          decide: async (decider, decided, context) => {
            seen.push([decider.id, decided.id, Boolean(context?.trx)])
            return 'yes' as never
          },
          list: async () => true,
        },
      },
    })
    await assert.rejects(
      () => denying.approve({ actorId: actor.id, userId: subject.id }),
      AuthorizationError
    )
    assert.deepEqual(seen, [[actor.id, subject.id, true]])
    assert.isNull(await status(subject))
  })

  test('reports unknown actors and subjects, and a disabled approval requirement', async ({
    assert,
  }) => {
    const actor = await owner()
    const { admission } = makeAdmission(kit, approvalOnly)
    await assert.rejects(
      () => admission.approve({ actorId: actor.id, userId: 999_999 }),
      UserNotFoundError
    )
    const subject = await insertUser(kit, { email: 'subject@example.test' })
    await assert.rejects(
      () => admission.approve({ actorId: 999_999, userId: subject.id }),
      InvalidInputError
    )
    const { admission: noApproval } = makeAdmission(kit, { invitation: { required: true } })
    for (const run of [
      () => noApproval.approve({ actorId: actor.id, userId: subject.id }),
      () => noApproval.reject({ actorId: actor.id, userId: subject.id }),
      () => noApproval.revoke({ actorId: actor.id, userId: subject.id }),
      () => noApproval.list({ actorId: actor.id }),
      () => noApproval.request({ userId: subject.id, revision: null }),
      () => noApproval.operator.approve({ email: subject.email }),
      () => noApproval.operator.revoke({ email: subject.email }),
    ])
      await assert.rejects(run, CapabilityDisabledError)
  })

  test('a failing event hook is a PostCommitError with the decision committed', async ({
    assert,
  }) => {
    const actor = await owner()
    const subject = await insertUser(kit, { email: 'subject@example.test' })
    const { admission } = makeAdmission(kit, {
      ...approvalOnly,
      onAdmissionEvent: async () => {
        throw new Error('audit log down')
      },
    })
    const error = await admission
      .approve({ actorId: actor.id, userId: subject.id })
      .catch((caught) => caught)
    assert.instanceOf(error, PostCommitError)
    assert.equal(await status(subject), 'approved')
  })

  test('concurrent decisions on one subject apply in some serial order', async ({ assert }) => {
    const first = await owner('first@example.test')
    const second = await owner('second@example.test')
    const { admission } = makeAdmission(kit, approvalOnly)
    for (const [left, right] of [
      ['approve', 'approve'],
      ['reject', 'reject'],
      ['approve', 'reject'],
    ] as const) {
      const subject = await insertUser(kit, { email: `${left}-${right}@example.test` })
      const results = await Promise.allSettled([
        admission[left]({ actorId: first.id, userId: subject.id }),
        admission[right]({ actorId: second.id, userId: subject.id }),
      ])
      const won = results.filter((result) => result.status === 'fulfilled')
      for (const result of results)
        if (result.status === 'rejected') assert.instanceOf(result.reason, AdmissionDecisionError)
      assert.lengthOf(await kit.db.from('account_admissions').where('user_id', subject.id), 1)
      const final = await status(subject)
      if (left === right) {
        assert.lengthOf(won, 1)
        assert.equal(final, left === 'approve' ? 'approved' : 'rejected')
      } else {
        // Approve then reject refuses the reject; reject then approve applies both.
        assert.equal(final, 'approved')
        assert.include([1, 2], won.length)
      }
    }
  })

  test('a rejection survives login, verification, magic link, social login and email change', async ({
    assert,
  }) => {
    const recorder = makeNotify()
    const adapters = { google: provider('subject-9', 'social@example.test', true) }
    const { admission, account } = makeAdmission(kit, approvalOnly, {
      enabled: [
        'passwordReset',
        'emailVerification',
        'emailPasswordManagement',
        'magicLinkLogin',
        'socialAuthentication',
      ],
      authentication: { strategy: 'session', guard: 'web' },
      socialAuthentication: { providers: adapters },
      notify: recorder.notify,
      minRequestMs: 0,
    })
    const guard = {
      strategy: 'session' as const,
      name: 'web',
      establish: async (_id: unknown, revision: string | null) => revision,
      terminate: async () => {},
    }
    const lastToken = () =>
      tokenFrom(
        recorder.calls
          .at(-1)!
          .args.find((arg) => typeof arg === 'string' && arg.startsWith('https://'))
      )
    const actor = await owner()
    const person = await insertUser(kit, {
      email: 'person@example.test',
      password: 'oldPassword123',
      verified: false,
    })
    await admission.reject({ actorId: actor.id, userId: person.id })

    await account.emailVerification.send({ userId: person.id })
    await account.emailVerification.complete({ token: lastToken(), password: 'oldPassword123' })
    await account.authentication.login(
      { email: person.email, password: 'oldPassword123', clientKey: 'client' },
      guard
    )
    const verifier = 'v'.repeat(43)
    await account.magicLink.request({
      email: person.email,
      clientKey: 'client',
      clientChallenge: clientChallengeFor(verifier),
    })
    await account.magicLink.complete({ token: lastToken(), verifier }, guard)
    const changed = await issueEmailChange(account, person, recorder, 'person2@example.test')
    await account.emailPasswordManagement.completeEmailChange({ token: changed })
    assert.equal(await status(person), 'rejected')

    const start = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const created = await account.socialAuthentication.callback({
      state: start.state,
      callback: {},
    })
    if (created.status !== 'new' || !('userId' in created)) throw new Error('Expected new account')
    const social = created.userId
    await admission.reject({ actorId: actor.id, userId: social })
    const again = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const linked = await account.socialAuthentication.callback({ state: again.state, callback: {} })
    assert.equal(linked.status, 'linked')
    assert.equal(
      (await kit.db.from('account_admissions').where('user_id', social).first()).approval_status,
      'rejected'
    )
    assert.isFalse(await admission.isAdmitted(person.id))
  })
})
