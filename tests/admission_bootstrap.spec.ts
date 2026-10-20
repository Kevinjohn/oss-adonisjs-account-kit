/* eslint-disable @unicorn/no-await-expression-member -- Keep each assertion next to the operation it inspects. */

import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import BootstrapAdmission from '../src/admission/commands/bootstrap.js'
import { withInvitationEvidence } from '../src/admission/invitation_evidence.js'
import { AccountAdmission } from '../src/admission/service.js'
import { transaction } from '../src/db.js'
import { EmailAlreadyRegisteredError, InvalidInputError } from '../src/errors.js'
import type { Invitation } from '../src/types.js'
import { aceKernel } from './helpers/ace_kernel.js'
import { dbTime } from './helpers/db_time.js'
import { useAdmissionApp } from './helpers/admission_schema.js'
import { allRequirements, makeAdmission } from './helpers/admission.js'
import { insertUser, tokenFrom } from './helpers/fakes.js'

test.group('admission bootstrap', (group) => {
  const kit = useAdmissionApp(group)

  const setup = () =>
    makeAdmission(kit, allRequirements, { onInvitationAccepted: withInvitationEvidence() })

  const waiting = () => kit.db.from('account_admissions').whereNull('user_id')

  const operatorInvitation = (email: string, inviterId: number | null, id = 99): Invitation => ({
    id,
    email,
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

  test('list and decisions never see a waiting approval', async ({ assert }) => {
    const { admission } = setup()
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    await admission.operator.bootstrap({ email: 'boss@example.test', role: 'owner' })
    assert.lengthOf((await admission.list({ actorId: actor.id })).items, 0)
    assert.lengthOf((await admission.list({ actorId: actor.id, status: 'approved' })).items, 0)
    // The waiting row is older than the account's row, yet the first page of one holds the account.
    const person = await insertUser(kit, { email: 'person@example.test' })
    await admission.operator.approve({ email: person.email })
    const page = await admission.list({ actorId: actor.id, limit: 1 })
    assert.deepEqual(
      page.items.map((item) => item.email),
      [person.email]
    )
    assert.isNull(page.nextCursor)
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

  test('a failed invitation removes the approval it wrote', async ({ assert }) => {
    const { admission, account } = setup()
    account.operator.invite = async () => {
      throw new Error('mail queue down')
    }
    await assert.rejects(
      () => admission.operator.bootstrap({ email: 'boss@example.test', role: 'owner' }),
      'mail queue down'
    )
    assert.lengthOf(await waiting(), 0)
  })

  test("a failed invitation leaves a later bootstrap's approval in place", async ({ assert }) => {
    const { admission, account } = setup()
    const invite = account.operator.invite.bind(account.operator)
    let later: Awaited<ReturnType<typeof invite>> | undefined
    account.operator.invite = async () => {
      // A second bootstrap for the address replaces this call's approval before it fails.
      account.operator.invite = invite
      later = await admission.operator.bootstrap({ email: 'boss@example.test', role: 'admin' })
      throw new Error('mail queue down')
    }
    await assert.rejects(
      () => admission.operator.bootstrap({ email: 'boss@example.test', role: 'owner' }),
      'mail queue down'
    )
    const [kept] = await waiting()
    assert.equal(kept?.invitation_id, later!.invitation.id)
  })

  test('the command prints the link and cancels', async ({ assert }) => {
    const { admission } = setup()
    kit.app.container.bindValue(AccountAdmission, admission)
    const { kernel, logs } = aceKernel(kit, [BootstrapAdmission])
    const stdout = () => logs().filter((entry) => entry.stream === 'stdout')
    const run = await kernel.exec('account-kit:admission:bootstrap', [
      'boss@example.test',
      '--role=owner',
    ])
    assert.equal(run.exitCode ?? 0, 0)
    const printed = JSON.parse(stdout().at(-1)!.message)
    assert.equal(printed.result, 'printed')
    assert.equal(printed.approval, 'approved')
    assert.match(printed.url, /invitation/)
    await kernel.exec('account-kit:admission:bootstrap', ['boss@example.test', '--cancel'])
    assert.deepEqual(JSON.parse(stdout().at(-1)!.message), {
      result: 'cancelled',
      email: 'boss@example.test',
    })
    const missingRole = await kernel.exec<typeof BootstrapAdmission>(
      'account-kit:admission:bootstrap',
      ['boss@example.test']
    )
    assert.equal(missingRole.failure, 'E_ACCOUNT_KIT_INVALID_INPUT')
  })
})
