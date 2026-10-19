import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService, tokenFrom } from './helpers/fakes.js'
test.group('token secret length', (group) => {
  const kit = useTestApp(group)

  test('non-default secret lengths issue redeemable proofs for every service', async ({
    assert,
  }) => {
    for (const length of [16, 64]) {
      const { account, recorder } = makeService(kit, { tokenSecretLength: length, minRequestMs: 0 })
      const verified = await insertUser(kit, { email: `verified-${length}@example.test` })
      const inactive = await insertUser(kit, {
        email: `inactive-${length}@example.test`,
        verified: false,
      })
      const expectedCharacters = Math.ceil((length * 8) / 6)
      const nextToken = (method: string) => {
        const call = recorder.calls.findLast((entry) => entry.method === method)
        assert.isDefined(call)
        if (!call) throw new Error('Missing proof notification')
        assert.equal(call.method, method)
        const token = tokenFrom(call.args.at(-1))
        assert.equal(token.length, expectedCharacters)
        return token
      }

      await account.emailVerification.send({ userId: inactive.id })
      assert.equal(
        await account.emailVerification.complete({
          token: nextToken('accountActivationProvision'),
          password: 'NewPassword123',
        }),
        'verified'
      )

      await account.passwordReset.request({ email: verified.email, clientKey: `reset-${length}` })
      await account.passwordReset.reset({
        token: nextToken('passwordResetProvision'),
        password: 'newPassword123',
      })

      await account.emailPasswordManagement.requestEmailChange({
        actorId: verified.id,
        currentPassword: 'newPassword123',
        newEmail: `changed-${length}@example.test`,
      })
      const changed = await account.emailPasswordManagement.completeEmailChange({
        token: nextToken('emailChangeProvision'),
      })
      assert.equal(changed.email, `changed-${length}@example.test`)

      await account.invitations.send({
        actorId: verified.id,
        email: `invited-${length}@example.test`,
        role: 'member',
      })
      const accepted = await account.invitations.accept({
        token: nextToken('invitationProvision'),
        password: 'newPassword123',
      })
      assert.equal(accepted.email, `invited-${length}@example.test`)
    }
  })
})
