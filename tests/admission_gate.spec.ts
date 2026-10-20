import { test } from '@japa/runner'
import { AdmissionRequiredError } from '../src/admission/errors.js'
import { admissionMiddleware } from '../src/admission/middleware.js'
import { advanceCredentialRevision } from '../src/authentication.js'
import { transaction } from '../src/db.js'
import { accountErrorResponse } from '../src/error_response.js'
import { InvalidSessionError, UnverifiedEmailError } from '../src/errors.js'
import type { AuthenticationConfig, CurrentAccountInput, Trx, UserId } from '../src/types.js'
import { useAdmissionApp } from './helpers/admission_schema.js'
import { allowDecisions, makeAdmission, writeAdmissionRow } from './helpers/admission.js'
import { insertUser, makeUsersAdapter, unwrapId } from './helpers/fakes.js'
import type { TestApp } from './helpers/app.js'

const approvalOnly = { approval: { required: true as const, authorize: allowDecisions } }

/** A signed-in credential for each strategy, and the input the guard would report for it. */
const strategies = {
  session: {
    authentication: { strategy: 'session', guard: 'web' } as AuthenticationConfig,
    signIn: async (_kit: TestApp, userId: UserId): Promise<CurrentAccountInput> => ({
      userId,
      revision: null,
    }),
  },
  access_tokens: {
    authentication: { strategy: 'access_tokens', guard: 'api' } as AuthenticationConfig,
    signIn: async (kit: TestApp, userId: UserId): Promise<CurrentAccountInput> => {
      const [tokenId] = await kit.db
        .table('auth_access_tokens')
        .insert({ tokenable_id: userId, hash: `token-${userId}` })
        .returning('id')
      return { userId, tokenId: unwrapId(tokenId) }
    },
  },
}

test.group('admission gate', (group) => {
  const kit = useAdmissionApp(group)

  for (const [strategy, { authentication, signIn }] of Object.entries(strategies)) {
    test(`admits an approved account and refuses a pending one (${strategy})`, async ({
      assert,
    }) => {
      const { admission } = makeAdmission(kit, approvalOnly, { authentication })
      const person = await insertUser(kit)
      const input = await signIn(kit, person.id)

      const pending = await admission.current(input)
      assert.equal(pending.account.id, person.id)
      assert.isFalse(pending.decision.admitted)
      const error = await admission.require(input).catch((caught) => caught)
      assert.instanceOf(error, AdmissionRequiredError)
      assert.deepEqual(error.decision, pending.decision)

      await writeAdmissionRow(kit, person.id, { approval: 'approved' })
      const admitted = await admission.require(input)
      assert.isTrue(admitted.decision.admitted)
    })

    test(`checks the credential before admission (${strategy})`, async ({ assert }) => {
      const { admission, config } = makeAdmission(kit, approvalOnly, { authentication })
      const person = await insertUser(kit)
      await writeAdmissionRow(kit, person.id, { approval: 'approved' })
      const input = await signIn(kit, person.id)
      await transaction(kit.db, (trx) => advanceCredentialRevision(trx, config, person.id))
      // A pending account fails the credential check first, not the admission check.
      await writeAdmissionRow(kit, person.id, {})
      await assert.rejects(() => admission.require(input), InvalidSessionError)
      await assert.rejects(() => admission.current(input), InvalidSessionError)
    })
  }

  test('refuses an unconfirmed account first unless active is false', async ({ assert }) => {
    const { admission } = makeAdmission(kit, approvalOnly, {
      authentication: strategies.session.authentication,
    })
    const person = await insertUser(kit, { verified: false })
    const input = { userId: person.id, revision: null }
    await assert.rejects(() => admission.require(input), UnverifiedEmailError)
    await assert.rejects(() => admission.require(input, { active: false }), AdmissionRequiredError)
    await writeAdmissionRow(kit, person.id, { approval: 'approved' })
    await assert.rejects(() => admission.require(input), UnverifiedEmailError)
    const passed = await admission.require(input, { active: false })
    assert.isFalse(passed.account.active)
  })

  test('reads the account and its admission in one transaction', async ({ assert }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const seen: Array<Trx | undefined> = []
    const { admission } = makeAdmission(kit, approvalOnly, {
      authentication: strategies.session.authentication,
      users: {
        ...users,
        findById: (id, trx, options) => {
          seen.push(trx)
          return users.findById(id, trx, options)
        },
      },
    })
    const person = await insertUser(kit)
    await writeAdmissionRow(kit, person.id, { approval: 'approved' })
    await admission.require({ userId: person.id, revision: null })
    assert.isAtLeast(seen.length, 2)
    assert.isDefined(seen[0])
    assert.isTrue(seen.every((trx) => trx === seen[0]))
  })

  test('maps a refusal to 403 with the code, and keeps the decision on the error', async ({
    assert,
  }) => {
    const { admission } = makeAdmission(kit, approvalOnly, {
      authentication: strategies.session.authentication,
    })
    const person = await insertUser(kit)
    await writeAdmissionRow(kit, person.id, { approval: 'revoked' })
    const error = await admission
      .require({ userId: person.id, revision: null })
      .catch((caught) => caught)
    assert.deepEqual(error.decision, {
      admitted: false,
      requirements: { approval: { met: false, status: 'revoked', requested: false } },
    })
    const mapped = accountErrorResponse(error)
    assert.equal(mapped?.status, 403)
    assert.equal(mapped?.body.code, 'E_ACCOUNT_KIT_ADMISSION_REQUIRED')
  })

  for (const [strategy, { authentication, signIn }] of Object.entries(strategies)) {
    test(`middleware checks the guard and admission before next (${strategy})`, async ({
      assert,
    }) => {
      const { admission } = makeAdmission(kit, approvalOnly, { authentication })
      const person = await insertUser(kit)
      const input = await signIn(kit, person.id)
      const guard = {
        strategy: authentication.strategy,
        name: authentication.guard,
        current: async () => input,
      }
      let reached = 0
      const handler = admissionMiddleware({ admission: async () => admission, guard })
      await assert.rejects(
        () => handler({} as never, async () => reached++),
        AdmissionRequiredError
      )
      await writeAdmissionRow(kit, person.id, { approval: 'approved' })
      await handler({} as never, async () => reached++)
      assert.equal(reached, 1)

      const wrongGuard = admissionMiddleware({
        admission: async () => admission,
        guard: { ...guard, name: 'other' },
      })
      await assert.rejects(
        () => wrongGuard({} as never, async () => reached++),
        /configured existing authentication guard/
      )
      assert.equal(reached, 1)
    })
  }

  test('middleware passes active: false through', async ({ assert }) => {
    const { admission } = makeAdmission(kit, approvalOnly, {
      authentication: strategies.session.authentication,
    })
    const person = await insertUser(kit, { verified: false })
    await writeAdmissionRow(kit, person.id, { approval: 'approved' })
    const guard = {
      strategy: 'session' as const,
      name: 'web',
      current: async () => ({ userId: person.id, revision: null }),
    }
    let reached = false
    await assert.rejects(
      () =>
        admissionMiddleware({ admission: async () => admission, guard })({} as never, async () => {
          reached = true
        }),
      UnverifiedEmailError
    )
    await admissionMiddleware({ admission: async () => admission, guard, active: false })(
      {} as never,
      async () => {
        reached = true
      }
    )
    assert.isTrue(reached)
  })
})
