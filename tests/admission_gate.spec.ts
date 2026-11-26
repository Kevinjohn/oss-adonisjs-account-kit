import AdmissionMiddleware from '../src/admission/middleware.ts'
import { test } from '@japa/runner'
import {
  E_ACCOUNT_KIT_ADMISSION_REQUIRED,
  E_ACCOUNT_KIT_INVALID_SESSION,
  E_ACCOUNT_KIT_UNVERIFIED_EMAIL,
} from '../src/errors.ts'
import { advanceCredentialRevision } from '../src/credential_revision.ts'
import { transaction } from '../src/db.ts'
import { accountErrorResponse } from '../src/error_response.ts'
import type { AuthenticationConfig, CurrentAccountInput, Trx, UserId } from '../src/types.ts'
import { useAdmissionApp } from './helpers/admission_schema.ts'
import { allowDecisions, makeAdmission, writeAdmissionRow } from './helpers/admission.ts'
import { insertUser, makeUsersAdapter, unwrapId } from './helpers/fakes.ts'
import type { TestApp } from './helpers/app.ts'
import { accessTokenDefaults } from './helpers/access_tokens.ts'

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
        .insert({ tokenable_id: userId, ...accessTokenDefaults, hash: `token-${userId}` })
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
      assert.instanceOf(error, E_ACCOUNT_KIT_ADMISSION_REQUIRED)
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
      await assert.rejects(() => admission.require(input), E_ACCOUNT_KIT_INVALID_SESSION)
      await assert.rejects(() => admission.current(input), E_ACCOUNT_KIT_INVALID_SESSION)
    })
  }

  test('refuses an unconfirmed account first unless active is false', async ({ assert }) => {
    const { admission } = makeAdmission(kit, approvalOnly, {
      authentication: strategies.session.authentication,
    })
    const person = await insertUser(kit, { verified: false })
    const input = { userId: person.id, revision: null }
    await assert.rejects(() => admission.require(input), E_ACCOUNT_KIT_UNVERIFIED_EMAIL)
    await assert.rejects(
      () => admission.require(input, { active: false }),
      E_ACCOUNT_KIT_ADMISSION_REQUIRED
    )
    await writeAdmissionRow(kit, person.id, { approval: 'approved' })
    await assert.rejects(() => admission.require(input), E_ACCOUNT_KIT_UNVERIFIED_EMAIL)
    const passed = await admission.require(input, { active: false })
    assert.isFalse(passed.account.active)
  })

  test('reads the account and its admission in one transaction', async ({ assert }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const seen: Array<Trx | undefined> = []
    const admissionReads: Trx[] = []
    const restore: Array<() => void> = []
    const { admission } = makeAdmission(kit, approvalOnly, {
      authentication: strategies.session.authentication,
      users: {
        ...users,
        findById: (id, trx) => {
          if (trx && !seen.includes(trx)) {
            const from = trx.from
            trx.from = function (...args: Parameters<typeof trx.from>) {
              if (args[0] === 'account_admissions') admissionReads.push(this)
              return from.apply(this, args)
            }
            restore.push(() => {
              trx.from = from
            })
          }
          seen.push(trx)
          return users.findById(id, trx)
        },
      },
    })
    try {
      const person = await insertUser(kit)
      await writeAdmissionRow(kit, person.id, { approval: 'approved' })
      await admission.require({ userId: person.id, revision: null })
      assert.isAtLeast(seen.length, 2)
      assert.isDefined(seen[0])
      assert.isTrue(seen.every((trx) => trx === seen[0]))
      assert.lengthOf(admissionReads, 1)
      assert.strictEqual(admissionReads[0], seen[0])
    } finally {
      for (const reset of restore.reverse()) reset()
    }
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
    assert.equal(mapped?.body.errors[0].code, 'E_ACCOUNT_KIT_ADMISSION_REQUIRED')
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
      const handler = new AdmissionMiddleware({ admission: async () => admission, guard })
      await assert.rejects(
        () => handler.handle({} as never, async () => reached++),
        E_ACCOUNT_KIT_ADMISSION_REQUIRED
      )
      await writeAdmissionRow(kit, person.id, { approval: 'approved' })
      await handler.handle({} as never, async () => reached++)
      assert.equal(reached, 1)

      const wrongGuard = new AdmissionMiddleware({
        admission: async () => admission,
        guard: { ...guard, name: 'other' },
      })
      await assert.rejects(
        () => wrongGuard.handle({} as never, async () => reached++),
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
        new AdmissionMiddleware({ admission: async () => admission, guard }).handle(
          {} as never,
          async () => {
            reached = true
          }
        ),
      E_ACCOUNT_KIT_UNVERIFIED_EMAIL
    )
    await new AdmissionMiddleware({
      admission: async () => admission,
      guard,
      active: false,
    }).handle({} as never, async () => {
      reached = true
    })
    assert.isTrue(reached)
  })
})
