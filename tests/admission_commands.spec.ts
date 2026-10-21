/* eslint-disable @unicorn/no-await-expression-member -- Keep each assertion next to the operation it inspects. */

import { test } from '@japa/runner'
import * as coreCommands from '../commands/main.js'
import ApproveAdmission from '../src/admission/commands/approve.js'
import RevokeAdmission from '../src/admission/commands/revoke.js'
import GrantInvitationEvidence from '../src/admission/commands/grant_invitation.js'
import * as admissionCommands from '../src/admission/commands/main.js'
import { AccountAdmission } from '../src/admission/service.js'
import { aceKernel } from './helpers/ace_kernel.js'
import { useAdmissionApp } from './helpers/admission_schema.js'
import { allRequirements, makeAdmission } from './helpers/admission.js'
import { insertUser } from './helpers/fakes.js'

test.group('admission runtime commands', (group) => {
  const kit = useAdmissionApp(group)

  function kernelFor() {
    const service = makeAdmission(kit, allRequirements)
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
    assert.lengthOf(stdout(), 0)
    assert.include(stderr()[0].message, 'E_ACCOUNT_KIT_USER_NOT_FOUND')

    await insertUser(kit, { email: 'person@example.test' })
    const revoke = await kernel.exec<typeof RevokeAdmission>('account-kit:admission:revoke', [
      'person@example.test',
    ])
    assert.equal(revoke.failure, 'E_ACCOUNT_KIT_ADMISSION_DECISION')
  })

  test('the loaders list the install and runtime commands', async ({ assert }) => {
    const core = (await coreCommands.getMetaData()).map((command) => command.commandName)
    assert.include(core, 'account-kit:admission:install')
    const runtime = (await admissionCommands.getMetaData()).map((command) => command.commandName)
    assert.sameMembers(runtime, [
      'account-kit:admission:approve',
      'account-kit:admission:revoke',
      'account-kit:admission:grant-invitation',
      'account-kit:admission:bootstrap',
    ])
  })
})
