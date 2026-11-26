import { test } from '@japa/runner'
import BootstrapAdmission from '../src/admission/commands/bootstrap.ts'
import {
  E_ACCOUNT_KIT_BOOTSTRAP_APPROVAL_CHANGED,
  E_ACCOUNT_KIT_INVALID_INPUT,
} from '../src/errors.ts'
import { withInvitationEvidence } from '../src/admission/invitation_evidence.ts'
import { AccountAdmission } from '../src/admission/service.ts'
import { aceKernel } from './helpers/ace_kernel.ts'
import { useAdmissionApp } from './helpers/admission_schema.ts'
import { allRequirements, makeAdmission } from './helpers/admission.ts'
import { tokenFrom } from './helpers/fakes.ts'

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
    assert.instanceOf(missingRole.error, E_ACCOUNT_KIT_INVALID_INPUT)
    assert.equal(missingRole.exitCode, 1)
    assert.lengthOf(stdout(), 2)
    const stderr = logs().filter((entry) => entry.stream === 'stderr')
    assert.lengthOf(stderr, 2)
    assert.include(stderr[0].message, 'bearer secret')
    assert.include(stderr[1].message, 'E_ACCOUNT_KIT_INVALID_INPUT')
    assert.notInclude(stderr[1].message, printed.url)
  })

  test('bootstrap explains how to recover if its waiting approval is cancelled after commit', async ({
    assert,
  }) => {
    const email = 'boss@example.test'
    let url: string | undefined
    let cancelled = false
    const { admission } = makeAdmission(kit, allRequirements, {
      enabled: ['invitations'],
      urls: {
        invitation: (proof) => {
          url = `https://example.test/invitation/${proof}`
          return url
        },
      },
      onLifecycleEvent: async (event) => {
        if (event.type === 'invitation.sent') {
          cancelled = await admission.operator.cancelBootstrap({ email })
        }
      },
    })
    kit.app.container.bindValue(AccountAdmission, admission)
    const { kernel, logs } = aceKernel(kit, [BootstrapAdmission])
    const command = await kernel.exec<typeof BootstrapAdmission>(
      'account-kit:admission:bootstrap',
      [email, '--role=owner']
    )

    assert.isTrue(cancelled)
    assert.isString(url)
    assert.instanceOf(command.error, E_ACCOUNT_KIT_BOOTSTRAP_APPROVAL_CHANGED)
    assert.instanceOf(command.error, E_ACCOUNT_KIT_INVALID_INPUT)
    assert.equal(command.error.code, 'E_ACCOUNT_KIT_INVALID_INPUT')
    assert.equal(command.error.status, 422)
    assert.equal(command.failure, 'E_ACCOUNT_KIT_INVALID_INPUT')
    assert.equal(command.exitCode, 1)
    assert.lengthOf(logs(), 1)
    assert.equal(logs()[0].stream, 'stderr')
    assert.include(
      logs()[0].message,
      'Bootstrap approval was replaced or cancelled. Run bootstrap again.'
    )
    assert.notInclude(logs()[0].message, tokenFrom(url))
  })
})
