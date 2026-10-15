import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import { ThrottledError } from '../src/errors.js'
import { useTestApp } from './helpers/app.js'
import {
  insertUser,
  makeConfig,
  makeNotify,
  makeService,
  makeUsersAdapter,
  tokenFrom,
} from './helpers/fakes.js'
import * as ts from 'typescript'

async function generatedInvitationAcceptanceHook(kit: ReturnType<typeof useTestApp>) {
  const stubsRoot = fileURLToPath(new URL('../stubs', import.meta.url))
  const stubs = await kit.app.stubs.create()
  const stub = await stubs.build('config/account_kit.stub', { source: stubsRoot })
  const rendered = await stub.prepare({
    config: { destination: join(tmpdir(), 'account_kit_generated_config.ts') },
  })
  const sourceFile = ts.createSourceFile(
    'account_kit_generated_config.ts',
    rendered.contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  let initializer: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'onInvitationAccepted'
    ) {
      initializer = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!initializer) throw new Error('Rendered config is missing onInvitationAccepted')

  const javascript = ts.transpileModule(
    `const hook = ${initializer.getText(sourceFile)}; export default hook`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }
  ).outputText
  const imported = await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  )
  return imported.default as (...args: never[]) => Promise<void>
}

test.group('password reset issuance and redemption boundaries', (group) => {
  const kit = useTestApp(group)

  test('exhausting request issuance does not prevent redeeming the latest valid token', async ({
    assert,
  }) => {
    await insertUser(kit)
    const recorder = makeNotify()
    const { account } = makeService(kit, {
      minRequestMs: 0,
      throttle: { requests: 1, duration: '1h' },
      notify: recorder.notify,
    })

    await account.passwordReset.request({ email: 'person@example.test', clientKey: 'first' })
    const token = tokenFrom(recorder.calls[0].args[1])
    await assert.rejects(
      () => account.passwordReset.request({ email: 'person@example.test', clientKey: 'second' }),
      ThrottledError
    )

    const resetUser = await account.passwordReset.reset({ token, password: 'new-password123' })
    const stored = await kit.db.from('users').where('id', resetUser.id).first()
    assert.equal(resetUser.email, 'person@example.test')
    assert.isTrue(await kit.hash.verify(stored.password, 'new-password123'))
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
    assert.deepEqual(
      recorder.calls.map((call) => call.method),
      ['passwordResetProvision', 'passwordResetCompleted']
    )
  })
})

test.group('generated invitation acceptance setup hook', (group) => {
  const kit = useTestApp(group)

  test('requires the acceptance hook to be present and callable when invitations are enabled', ({
    assert,
  }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash), enabled: ['invitations'] })
    assert.throws(
      () => defineConfig({ ...base, onInvitationAccepted: undefined }),
      /onInvitationAccepted must be a function/
    )
    assert.throws(
      () => defineConfig({ ...base, onInvitationAccepted: 'not callable' } as never),
      /onInvitationAccepted must be a function/
    )
  })

  test('the rendered placeholder throws inside acceptance and rolls back user and token consumption', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'inviter@example.test' })
    const hook = await generatedInvitationAcceptanceHook(kit)
    const { account, recorder } = makeService(kit, {
      minRequestMs: 0,
      onInvitationAccepted: hook as never,
    })
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email: 'invitee@example.test',
      role: 'member',
    })
    const token = tokenFrom(recorder.calls[0].args[1])

    await assert.rejects(
      () => account.invitations.accept({ token, password: 'new-password123' }),
      'account_kit: implement onInvitationAccepted in config/account_kit.stub'
    )
    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 0)
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
    assert.lengthOf(recorder.calls, 1)
  })
})
