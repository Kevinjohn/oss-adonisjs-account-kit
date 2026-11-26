import { test } from '@japa/runner'
import * as coreCommands from '../commands/main.ts'
import ApproveAdmission from '../commands/admission/approve.ts'
import RevokeAdmission from '../commands/admission/revoke.ts'
import GrantInvitationEvidence from '../commands/admission/grant_invitation.ts'
import * as admissionCommands from '../src/admission/commands/main.ts'
import type { AdmissionConfig } from '../src/admission/types.ts'
import {
  E_ACCOUNT_KIT_ADMISSION_DECISION,
  E_ACCOUNT_KIT_POST_COMMIT,
  E_ACCOUNT_KIT_USER_NOT_FOUND,
} from '../src/errors.ts'
import { AccountAdmission } from '../src/admission/service.ts'
import { aceKernel } from './helpers/ace_kernel.ts'
import { useAdmissionApp } from './helpers/admission_schema.ts'
import { allRequirements, makeAdmission } from './helpers/admission.ts'
import { insertUser } from './helpers/fakes.ts'

test.group('admission runtime commands', (group) => {
  const kit = useAdmissionApp(group)

  function kernelFor(config: AdmissionConfig = allRequirements) {
    const service = makeAdmission(kit, config)
    kit.app.container.bindValue(AccountAdmission, service.admission)
    const { kernel, logs } = aceKernel(kit, [
      ApproveAdmission,
      RevokeAdmission,
      GrantInvitationEvidence,
    ])
    const stdout = () => logs().filter((entry) => entry.stream === 'stdout')
    const stderr = () => logs().filter((entry) => entry.stream === 'stderr')
    return { kernel, stdout, stderr }
  }

  test('approve, grant-invitation and revoke write one JSON line each', async ({ assert }) => {
    const person = await insertUser(kit, { email: 'boss@example.test' })
    const { kernel, stdout, stderr } = kernelFor()
    const approve = await kernel.exec('account-kit:admission:approve', ['boss@example.test'])
    assert.equal(approve.exitCode ?? 0, 0)
    const grant = await kernel.exec('account-kit:admission:grant-invitation', [
      'boss@example.test',
      '--role=owner',
    ])
    assert.equal(grant.exitCode ?? 0, 0)
    await kernel.exec('account-kit:admission:revoke', ['boss@example.test'])
    assert.deepEqual(
      stdout().map((entry) => JSON.parse(entry.message)),
      [
        { result: 'approved', userId: person.id, email: person.email },
        { result: 'granted', userId: person.id, email: person.email, role: 'owner' },
        { result: 'revoked', userId: person.id, email: person.email },
      ]
    )
    assert.lengthOf(stderr(), 0)
    const row = await kit.db.from('account_admissions').where('user_id', person.id).first()
    assert.equal(row.approval_status, 'revoked')
    assert.isNull(row.approval_actor_id)
  })

  test('failures go to stderr with the code and exit 1', async ({ assert }) => {
    const { kernel, stdout, stderr } = kernelFor()
    const command = await kernel.exec<typeof ApproveAdmission>('account-kit:admission:approve', [
      'missing@example.test',
    ])
    assert.equal(command.exitCode, 1)
    assert.equal(command.failure, 'E_ACCOUNT_KIT_USER_NOT_FOUND')
    assert.instanceOf(command.error, E_ACCOUNT_KIT_USER_NOT_FOUND)
    assert.lengthOf(stdout(), 0)
    assert.lengthOf(stderr(), 1)
    assert.include(stderr()[0].message, 'E_ACCOUNT_KIT_USER_NOT_FOUND')

    await insertUser(kit, { email: 'person@example.test' })
    const revoke = await kernel.exec<typeof RevokeAdmission>('account-kit:admission:revoke', [
      'person@example.test',
    ])
    assert.equal(revoke.failure, 'E_ACCOUNT_KIT_ADMISSION_DECISION')
    assert.equal(revoke.exitCode, 1)
    assert.instanceOf(revoke.error, E_ACCOUNT_KIT_ADMISSION_DECISION)
    assert.lengthOf(stderr(), 2)
    assert.include(stderr()[1].message, 'E_ACCOUNT_KIT_ADMISSION_DECISION')

    const grant = await kernel.exec<typeof GrantInvitationEvidence>(
      'account-kit:admission:grant-invitation',
      ['missing@example.test']
    )
    assert.equal(grant.failure, 'E_ACCOUNT_KIT_USER_NOT_FOUND')
    assert.equal(grant.exitCode, 1)
    assert.instanceOf(grant.error, E_ACCOUNT_KIT_USER_NOT_FOUND)
    assert.lengthOf(stdout(), 0)
    assert.lengthOf(stderr(), 3)
    assert.include(stderr()[2].message, 'E_ACCOUNT_KIT_USER_NOT_FOUND')
  })

  test('approve exposes a committed observer error and reports the saved change', async ({
    assert,
  }) => {
    const person = await insertUser(kit, { email: 'boss@example.test' })
    const cause = new Error('private observer failure')
    const { kernel, stdout, stderr } = kernelFor({
      ...allRequirements,
      onAdmissionNotification: async () => {
        throw cause
      },
    })

    const command = await kernel.exec<typeof ApproveAdmission>('account-kit:admission:approve', [
      'boss@example.test',
    ])

    assert.instanceOf(command.error, E_ACCOUNT_KIT_POST_COMMIT)
    assert.equal(command.failure, 'E_ACCOUNT_KIT_POST_COMMIT')
    assert.equal(command.exitCode, 1)
    assert.isNull(command.result)
    assert.lengthOf(stdout(), 0)
    assert.lengthOf(stderr(), 1)
    assert.include(stderr()[0].message, 'committed')
    assert.notInclude(stderr()[0].message, cause.message)
    const row = await kit.db.from('account_admissions').where('user_id', person.id).first()
    assert.equal(row.approval_status, 'approved')
  })

  test('the loaders list the install and runtime commands', async ({ assert }) => {
    // eslint-disable-next-line @unicorn/no-await-expression-member -- Assert the result at the call site.
    const core = (await coreCommands.getMetaData()).map((command) => command.commandName)
    assert.include(core, 'account-kit:admission:install')
    // eslint-disable-next-line @unicorn/no-await-expression-member -- Assert the result at the call site.
    const runtime = (await admissionCommands.getMetaData()).map((command) => command.commandName)
    assert.sameMembers(runtime, [
      'account-kit:admission:approve',
      'account-kit:admission:revoke',
      'account-kit:admission:grant-invitation',
      'account-kit:admission:bootstrap',
    ])
  })
})
