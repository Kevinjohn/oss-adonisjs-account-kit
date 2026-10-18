import { test } from '@japa/runner'
import { Kernel, ListLoader } from '@adonisjs/core/ace'
import InviteAccount from '../commands/invite.js'
import ResetLink from '../commands/reset_link.js'
import * as commandLoader from '../commands/main.js'
import { AccountKit } from '../src/account_kit.js'
import type { AccountKitConfig } from '../src/types.js'
import { useTestApp, type TestApp } from './helpers/app.js'
import { insertUser, makeService, tokenFrom } from './helpers/fakes.js'

function kernelFor(kit: TestApp, overrides: Partial<AccountKitConfig> = {}) {
  const service = makeService(kit, overrides)
  kit.app.container.bindValue(AccountKit, service.account)
  const kernel = new Kernel(kit.app)
  kernel.addLoader(new ListLoader([InviteAccount, ResetLink]))
  kernel.ui.switchMode('raw')
  const logs = () => kernel.ui.logger.getLogs() as Array<{ message: string; stream: string }>
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

  test('invite --print prints the link, warns on stderr, and sends nothing', async ({
    assert,
  }) => {
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
    assert.lengthOf(stdout(), 0)
    assert.include(stderr()[0].message, 'E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED')
  })

  test('invite requires --role', async ({ assert }) => {
    const { kernel } = kernelFor(kit)
    await assert.rejects(() => kernel.exec('account-kit:invite', ['x@example.test']), /role/)
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
  })

  test('invite keeps the printed link when a follow-up fails and exits 1', async ({ assert }) => {
    const { kernel, stdout } = kernelFor(kit, {
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
    assert.equal(output.fault.name, 'PostCommitError')
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
    assert.lengthOf(stdout(), 1)
  })

  test('the package command loader lists and runs both commands', async ({ assert }) => {
    await insertUser(kit, { email: 'loader@example.test' })
    const service = makeService(kit)
    kit.app.container.bindValue(AccountKit, service.account)
    const metadata = await commandLoader.getMetaData()
    const names = metadata.map((item) => item.commandName)
    assert.includeMembers(names, ['account-kit:invite', 'account-kit:reset-link'])
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
