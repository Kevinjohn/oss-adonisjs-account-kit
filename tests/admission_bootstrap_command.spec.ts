import { test } from '@japa/runner'
import BootstrapAdmission from '../src/admission/commands/bootstrap.js'
import { withInvitationEvidence } from '../src/admission/invitation_evidence.js'
import { AccountAdmission } from '../src/admission/service.js'
import { aceKernel } from './helpers/ace_kernel.js'
import { useAdmissionApp } from './helpers/admission_schema.js'
import { allRequirements, makeAdmission } from './helpers/admission.js'

test.group('admission bootstrap', (group) => {
  const kit = useAdmissionApp(group)

  const setup = () =>
    makeAdmission(kit, allRequirements, { onInvitationAccepted: withInvitationEvidence() })

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
