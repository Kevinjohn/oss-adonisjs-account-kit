import { test } from '@japa/runner'
import { Kernel } from '@adonisjs/core/ace'
import InviteAccount from '../commands/invite.js'
import ResetLink from '../commands/reset_link.js'
import * as commandLoader from '../commands/main.js'
import {
  E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED,
  E_ACCOUNT_KIT_INVALID_INPUT,
  E_ACCOUNT_KIT_USER_NOT_FOUND,
} from '../src/errors.js'
import { AccountKit } from '../src/account_kit.js'
import type { AccountKitConfig } from '../src/types.js'
import { aceKernel } from './helpers/ace_kernel.js'
import { useTestApp, type TestApp } from './helpers/app.js'
import { insertUser, makeService, tokenFrom } from './helpers/fakes.js'

function kernelFor(kit: TestApp, overrides: Partial<AccountKitConfig> = {}) {
  const service = makeService(kit, overrides)
  kit.app.container.bindValue(AccountKit, service.account)
  const { kernel, logs } = aceKernel(kit, [InviteAccount, ResetLink])
  const stdout = () => logs().filter((entry) => entry.stream === 'stdout')
  const stderr = () => logs().filter((entry) => entry.stream === 'stderr')
  return { kernel, service, stdout, stderr }
}

test.group('operator commands', (group) => {
  const kit = useTestApp(group)

  test('invite sends by default and writes one JSON line to stdout', async ({ assert }) => {
    const { kernel, service, stdout, stderr } = kernelFor(kit)
    const command = await kernel.exec<typeof InviteAccount>('account-kit:invite', [
      'new@example.test',
      '--role=admin',
    ])
    assert.equal(command.exitCode ?? 0, 0)
    assert.lengthOf(stdout(), 1)
    const output = JSON.parse(stdout()[0].message)
    assert.equal(output.result, 'sent')
    assert.equal(output.email, 'new@example.test')
    assert.equal(output.role, 'admin')
    assert.notProperty(output, 'url')
    assert.lengthOf(stderr(), 0)
    assert.equal(service.recorder.calls[0].method, 'invitationProvision')
  })

  test('invite stores accepted role text exactly and rejects an out-of-range role', async ({
    assert,
  }) => {
    const { kernel } = kernelFor(kit)
    const inputs = [' ', ' admin ', 'r'.repeat(64)]
    for (const [index, role] of inputs.entries()) {
      const command = await kernel.exec<typeof InviteAccount>('account-kit:invite', [
        `operator-${index}@example.test`,
        `--role=${role}`,
      ])
      assert.equal(command.exitCode ?? 0, 0)
      assert.equal(command.result?.invitation.role, role)
    }

    const rejectedRole = 'r'.repeat(65)
    const command = await kernel.exec<typeof InviteAccount>('account-kit:invite', [
      'invalid@example.test',
      `--role=${rejectedRole}`,
    ])
    assert.equal(command.exitCode, 1)
    assert.equal(command.failure, 'E_ACCOUNT_KIT_INVALID_INPUT')
    const rows = await kit.db.from('account_invitations').orderBy('id')
    assert.deepEqual(
      rows.map((row) => row.role),
      inputs
    )
  })

  test('invite --print prints the link, warns on stderr, and sends nothing', async ({ assert }) => {
    const { kernel, service, stdout, stderr } = kernelFor(kit)
    await kernel.exec('account-kit:invite', ['boss@example.test', '--role=admin', '--print'])
    const output = JSON.parse(stdout()[0].message)
    assert.equal(output.result, 'printed')
    assert.match(output.url, /^https:\/\/example\.test\/invitation\//)
    assert.lengthOf(service.recorder.calls, 0)
    assert.lengthOf(stderr(), 1)
    assert.include(stderr()[0].message, 'bearer secret')
    assert.notInclude(stderr()[0].message, output.url)
    const accepted = await service.account.invitations.accept({
      token: tokenFrom(output.url),
      password: 'first-admin-password',
    })
    assert.equal(accepted.email, 'boss@example.test')
  })

  test('invite reports domain failures on stderr with exit code 1', async ({ assert }) => {
    await insertUser(kit, { email: 'taken@example.test' })
    const { kernel, stdout, stderr } = kernelFor(kit)
    const command = await kernel.exec<typeof InviteAccount>('account-kit:invite', [
      'taken@example.test',
      '--role=admin',
    ])
    assert.equal(command.exitCode, 1)
    assert.equal(command.failure, 'E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED')
    assert.instanceOf(command.error, E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED)
    assert.lengthOf(stdout(), 0)
    assert.lengthOf(stderr(), 1)
    assert.include(stderr()[0].message, 'E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED')
  })

  test('invite keeps a URL builder error without printing its proof or cause', async ({
    assert,
  }) => {
    const cause = new Error('private callback failure')
    const error = new E_ACCOUNT_KIT_INVALID_INPUT('private URL builder failure', { cause })
    let proof: string | undefined
    const { kernel, stdout, stderr } = kernelFor(kit, {
      enabled: ['invitations'],
      urls: {
        invitation: (token) => {
          proof = token
          error.message = `Could not build https://example.test/invitation/${token}`
          throw error
        },
      },
    })
    const command = await kernel.exec<typeof InviteAccount>('account-kit:invite', [
      'new@example.test',
      '--role=admin',
      '--print',
    ])
    assert.strictEqual(command.error, error)
    assert.equal(command.exitCode, 1)
    assert.equal(command.failure, 'E_ACCOUNT_KIT_INVALID_INPUT')
    assert.isString(proof)
    assert.lengthOf(stdout(), 0)
    assert.lengthOf(stderr(), 1)
    assert.include(stderr()[0].message, 'E_ACCOUNT_KIT_INVALID_INPUT')
    assert.notInclude(stderr()[0].message, proof!)
    assert.notInclude(stderr()[0].message, cause.message)
  })

  test('invite requires --role', async ({ assert }) => {
    const { kernel } = kernelFor(kit)
    await assert.rejects(() => kernel.exec('account-kit:invite', ['x@example.test']), /role/)
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
  })

  test('invite keeps the printed link when a follow-up fails and exits 1', async ({ assert }) => {
    const { kernel, stdout, stderr } = kernelFor(kit, {
      onLifecycleEvent: async () => {
        throw new Error('observer down')
      },
    })
    const command = await kernel.exec<typeof InviteAccount>('account-kit:invite', [
      'late@example.test',
      '--role=admin',
      '--print',
    ])
    assert.equal(command.exitCode, 1)
    const output = JSON.parse(stdout()[0].message)
    assert.isString(output.url)
    assert.equal(output.fault.name, 'PostCommitException')
    assert.equal(output.fault.code, 'E_ACCOUNT_KIT_POST_COMMIT')
    assert.equal(command.failure, 'E_ACCOUNT_KIT_POST_COMMIT')
    assert.isUndefined(command.error)
    assert.lengthOf(stderr(), 2)
    assert.include(stderr()[0].message, 'bearer secret')
    assert.include(stderr()[1].message, 'committed but a follow-up failed')
    assert.notInclude(stderr()[1].message, output.url)
    assert.notInclude(stderr()[1].message, 'observer down')
  })

  test('reset-link sends by default and --print prints a working link', async ({ assert }) => {
    await insertUser(kit, { email: 'person@example.test' })
    const { kernel, service, stdout, stderr } = kernelFor(kit)
    await kernel.exec('account-kit:reset-link', ['person@example.test'])
    assert.equal(JSON.parse(stdout()[0].message).result, 'sent')
    assert.equal(service.recorder.calls[0].method, 'passwordResetProvision')
    assert.lengthOf(stderr(), 0)

    await kernel.exec('account-kit:reset-link', ['person@example.test', '--print'])
    const output = JSON.parse(stdout()[1].message)
    assert.equal(output.result, 'printed')
    assert.include(stderr()[0].message, 'bearer secret')
    await service.account.passwordReset.reset({
      token: tokenFrom(output.url),
      password: 'brand-new-password',
    })
  })

  test('reset-link keeps an unexpected configured builder error and prints one diagnostic', async ({
    assert,
  }) => {
    await insertUser(kit, { email: 'person@example.test' })
    const error = new Error('private configured reset failure')
    const { kernel, stdout, stderr } = kernelFor(kit, {
      enabled: ['passwordReset'],
      urls: {
        passwordReset: () => {
          throw error
        },
      },
    })

    const command = await kernel.exec<typeof ResetLink>('account-kit:reset-link', [
      'person@example.test',
    ])

    assert.strictEqual(command.error, error)
    assert.equal(command.failure, 'E_ACCOUNT_KIT_OPERATOR')
    assert.equal(command.exitCode, 1)
    assert.lengthOf(stdout(), 0)
    assert.lengthOf(stderr(), 1)
    assert.include(stderr()[0].message, 'E_ACCOUNT_KIT_OPERATOR')
    assert.notInclude(stderr()[0].message, error.message)
  })

  test('reset-link warns for an inactive account and fails for an unknown one', async ({
    assert,
  }) => {
    await insertUser(kit, { email: 'pending@example.test', verified: false })
    const { kernel, stdout, stderr } = kernelFor(kit)
    await kernel.exec('account-kit:reset-link', ['pending@example.test', '--print'])
    assert.isTrue(stderr().some((entry) => entry.message.includes('has not verified')))
    const missing = await kernel.exec<typeof ResetLink>('account-kit:reset-link', [
      'nobody@example.test',
    ])
    assert.equal(missing.exitCode, 1)
    assert.equal(missing.failure, 'E_ACCOUNT_KIT_USER_NOT_FOUND')
    assert.instanceOf(missing.error, E_ACCOUNT_KIT_USER_NOT_FOUND)
    assert.include(stderr().at(-1)!.message, 'E_ACCOUNT_KIT_USER_NOT_FOUND')
    assert.lengthOf(stdout(), 1)
  })

  test('the package command loader lists and runs both commands', async ({ assert }) => {
    await insertUser(kit, { email: 'loader@example.test' })
    const service = makeService(kit)
    kit.app.container.bindValue(AccountKit, service.account)
    const metadata = await commandLoader.getMetaData()
    const names = metadata.map((item) => item.commandName)
    assert.includeMembers(names, ['account-kit:invite', 'account-kit:reset-link'])
    assert.include(
      metadata.find((item) => item.commandName === 'account-kit:invite')?.description,
      'same address and scope'
    )
    const kernel = new Kernel(kit.app)
    kernel.addLoader(commandLoader as never)
    kernel.ui.switchMode('raw')
    const command = await kernel.exec<typeof ResetLink>('account-kit:reset-link', [
      'loader@example.test',
      '--print',
    ])
    assert.equal(command.exitCode ?? 0, 0)
    assert.isString(command.result?.url)
  })
})
