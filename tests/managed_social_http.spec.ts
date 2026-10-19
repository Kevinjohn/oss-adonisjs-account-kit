import { createHash } from 'node:crypto'
import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import type { AccountKit } from '../src/account_kit.js'
import type { ManagedGuard } from '../src/http/managed.js'
import { executeManagedSocial, rememberManagedMethod } from '../src/http/social.js'
import { stubGuard } from './helpers/managed_http_fakes.js'

type SocialAuthentication = AccountKit['socialAuthentication']

function context(body: Record<string, unknown> = {}, params: Record<string, string> = {}) {
  const values = new Map<string, unknown>()
  const session = {
    get: (key: string) => values.get(key),
    put: (key: string, value: unknown) => values.set(key, value),
    forget: (key: string) => values.delete(key),
  }
  const response = {
    ok: (value: unknown) => ({ status: 200, body: value }),
    noContent: () => ({ status: 204 }),
  }
  return {
    params,
    session,
    request: {
      validateUsing: async () => body,
      input: (key: string) => body[key],
    },
    response,
  } as unknown as HttpContext
}

function guard(
  strategy: 'session' | 'access_tokens' = 'session'
): ManagedGuard<{ opaque: string }> {
  return stubGuard({
    strategy,
    current: async () => ({ userId: 7, revision: 'trusted' }),
    publicCredential: (credential) => credential.opaque,
  })
}

function seedSessionState(
  ctx: HttpContext,
  state: string,
  value: { verifier: string; intent: string; provider: string; expiresAt?: number }
): void {
  const key = `accountKit.social.${createHash('sha256').update(state).digest('hex')}`
  const expiresAt = value.expiresAt ?? Date.now() + 10 * 60 * 1000
  const session = (ctx as unknown as { session: { put(key: string, value: unknown): void } })
    .session
  session.put(key, { ...value, expiresAt })
  session.put('accountKit.social.pendingStates', [{ key, expiresAt }])
}

const social = { providers: ['google'] as const }

test.group('managed social HTTP', () => {
  test('a failing signed hint writer cannot fail established authentication', async ({
    assert,
  }) => {
    const ctx = context()
    await assert.doesNotReject(() =>
      rememberManagedMethod(ctx, 'google', {
        providers: ['google'],
        rememberLastUsedMethod: async () => {
          throw new Error('signed cookie write failed')
        },
      })
    )
  })
  test('both callback transports reject absent, empty and non-string codes before Ally', async ({
    assert,
  }) => {
    let called = false
    const service = {
      callback: async () => {
        called = true
      },
    } as unknown as SocialAuthentication
    for (const code of [undefined, '', 7]) {
      for (const [name, strategy] of [
        ['auth.oauth.callback', 'session'],
        ['auth.oauth.complete', 'access_tokens'],
      ] as const) {
        const ctx = context({ state: 'callback-state', code }, { provider: 'google' })
        await assert.rejects(
          () => executeManagedSocial(name, ctx, service, guard(strategy), social),
          /Invalid social transaction/
        )
      }
    }
    assert.isFalse(called)
  })

  test('session begin creates a server-held verifier and binds its challenge to the service', async ({
    assert,
  }) => {
    const ctx = context(
      { intent: 'login', clientChallenge: 'caller-controlled' },
      { provider: 'google' }
    )
    let challenge = ''
    const service = {
      begin: async (input: { clientChallenge: string }) => {
        challenge = input.clientChallenge
        return { state: 'server-state', url: 'https://provider.example/authorize' }
      },
    } as unknown as SocialAuthentication
    const result = await executeManagedSocial('auth.oauth.redirect', ctx, service, guard(), social)
    const key = `accountKit.social.${createHash('sha256').update('server-state').digest('hex')}`
    const saved = (
      ctx as unknown as { session: { get(key: string): { verifier: string } } }
    ).session.get(key)
    assert.equal(challenge, createHash('sha256').update(saved.verifier).digest('base64url'))
    assert.notEqual(challenge, 'caller-controlled')
    assert.deepEqual(result, {
      status: 200,
      body: { authorizationUrl: 'https://provider.example/authorize' },
    })
  })

  test('abandoned session states are bounded and expired entries are pruned', async ({
    assert,
  }) => {
    const ctx = context({ intent: 'login' }, { provider: 'google' })
    const store = (ctx as unknown as { session: { get(key: string): unknown } }).session
    seedSessionState(ctx, 'expired-state', {
      verifier: 'expired',
      intent: 'login',
      provider: 'google',
      expiresAt: Date.now() - 1,
    })
    let next = 0
    const service = {
      begin: async () => ({ state: `new-state-${++next}`, url: 'https://provider.example' }),
    } as unknown as SocialAuthentication
    for (let i = 0; i < 12; i++)
      await executeManagedSocial('auth.oauth.redirect', ctx, service, guard(), social)
    const entries = store.get('accountKit.social.pendingStates') as Array<{ key: string }>
    assert.lengthOf(entries, 8)
    const expiredKey = `accountKit.social.${createHash('sha256').update('expired-state').digest('hex')}`
    const oldestKey = `accountKit.social.${createHash('sha256').update('new-state-1').digest('hex')}`
    assert.isUndefined(store.get(expiredKey))
    assert.isUndefined(store.get(oldestKey))
    assert.isTrue(entries.every(({ key }) => store.get(key) !== undefined))
  })

  test('session callback redeems with the stored verifier and does not put a credential in JSON', async ({
    assert,
  }) => {
    const ctx = context({ state: 'callback-state', code: 'provider-code' }, { provider: 'google' })
    seedSessionState(ctx, 'callback-state', {
      verifier: 'server-verifier',
      intent: 'login',
      provider: 'google',
    })
    const service = {
      callback: async (input: unknown) => {
        assert.deepEqual(input, {
          state: 'callback-state',
          provider: 'google',
          intent: 'login',
          current: undefined,
          callback: ctx,
        })
        return { status: 'linked', userId: 7, handoffCode: 'once' }
      },
      redeemHandoff: async (input: { verifier: string; code: string }) => {
        assert.equal(input.verifier, 'server-verifier')
        assert.equal(input.code, 'once')
        return { account: { id: 7, active: true }, credential: { opaque: 'never-in-JSON' } }
      },
    } as unknown as SocialAuthentication
    const result = await executeManagedSocial('auth.oauth.callback', ctx, service, guard(), social)
    assert.deepEqual(result, {
      status: 200,
      body: { status: 'linked', account: { id: 7, active: true } },
    })
    assert.notInclude(JSON.stringify(result), 'never-in-JSON')
  })

  test('session confirmation creates a server-held verifier and stores a confirm intent', async ({
    assert,
  }) => {
    const ctx = context(
      { verificationToken: 'verify-token', clientChallenge: 'caller-controlled' },
      { provider: 'google' }
    )
    let challenge = ''
    const service = {
      beginConfirmation: async (input: { clientChallenge: string }) => {
        challenge = input.clientChallenge
        return { state: 'confirm-state', url: 'https://provider.example/confirm' }
      },
    } as unknown as SocialAuthentication
    const result = await executeManagedSocial(
      'auth.oauth.confirmation',
      ctx,
      service,
      guard(),
      social
    )
    const key = `accountKit.social.${createHash('sha256').update('confirm-state').digest('hex')}`
    const saved = (
      ctx as unknown as {
        session: { get(key: string): { verifier: string; intent: string; provider: string } }
      }
    ).session.get(key)
    assert.equal(challenge, createHash('sha256').update(saved.verifier).digest('base64url'))
    assert.notEqual(challenge, 'caller-controlled')
    assert.equal(saved.intent, 'confirm')
    assert.equal(saved.provider, 'google')
    assert.deepEqual(result, {
      status: 200,
      body: { authorizationUrl: 'https://provider.example/confirm' },
    })
  })

  test('session registration redeems with the stored verifier and remembers its provider', async ({
    assert,
  }) => {
    const ctx = context({ continuation: 'continuation-state', email: 'new@example.test' })
    seedSessionState(ctx, 'continuation-state', {
      verifier: 'server-verifier',
      intent: 'login',
      provider: 'google',
    })
    let remembered: string | null = null
    const service = {
      completeRegistration: async () => ({ status: 'new', userId: 7, handoffCode: 'once' }),
      redeemHandoff: async (input: { verifier: string; code: string }) => {
        assert.equal(input.verifier, 'server-verifier')
        assert.equal(input.code, 'once')
        return { account: { id: 7, active: true }, credential: { opaque: 'never-in-JSON' } }
      },
    } as unknown as SocialAuthentication
    const result = await executeManagedSocial('auth.oauth.registration', ctx, service, guard(), {
      ...social,
      rememberLastUsedMethod: async (_context, method) => {
        remembered = method
      },
    })
    assert.deepEqual(result, {
      status: 200,
      body: { status: 'new', account: { id: 7, active: true } },
    })
    assert.equal(remembered, 'google')
    const key = `accountKit.social.${createHash('sha256').update('continuation-state').digest('hex')}`
    assert.isUndefined(
      (ctx as unknown as { session: { get(key: string): unknown } }).session.get(key)
    )
  })

  test('session callback rejects a provider different from the initiating transaction', async ({
    assert,
  }) => {
    const ctx = context({ state: 'callback-state', code: 'provider-code' }, { provider: 'google' })
    seedSessionState(ctx, 'callback-state', {
      verifier: 'server-verifier',
      intent: 'login',
      provider: 'github',
    })
    let called = false
    const service = {
      callback: async () => {
        called = true
      },
    } as unknown as SocialAuthentication
    await assert.rejects(
      () => executeManagedSocial('auth.oauth.callback', ctx, service, guard(), social),
      /Invalid social transaction/
    )
    assert.isFalse(called)
  })

  test('token link completion passes only selected-guard actor evidence to the service', async ({
    assert,
  }) => {
    const ctx = context(
      { state: 'callback-state', code: 'provider-code', intent: 'link' },
      { provider: 'google' }
    )
    const service = {
      callback: async (input: { current?: unknown; callback: unknown; intent?: string }) => {
        assert.deepEqual(input.current, { userId: 7, revision: 'trusted' })
        assert.equal(input.intent, 'link')
        assert.strictEqual(input.callback, ctx)
        return { status: 'linked', userId: 7 }
      },
    } as unknown as SocialAuthentication
    const result = await executeManagedSocial(
      'auth.oauth.complete',
      ctx,
      service,
      guard('access_tokens'),
      social
    )
    assert.deepEqual(result, { status: 200, body: { status: 'linked' } })
  })

  test('identity listing omits provider subject and internal user id', async ({ assert }) => {
    const ctx = context()
    const service = {
      list: async () => [
        {
          id: 2,
          userId: 7,
          provider: 'google',
          providerUserId: 'private-subject',
          email: 'owner@example.test',
          emailVerified: true,
        },
      ],
    } as unknown as SocialAuthentication
    const result = await executeManagedSocial(
      'account.socialIdentities.list',
      ctx,
      service,
      guard(),
      social
    )
    assert.deepEqual(result, {
      status: 200,
      body: {
        identities: [
          { id: 2, provider: 'google', email: 'owner@example.test', emailVerified: true },
        ],
      },
    })
  })

  test('methods discards a client hint outside the selected public allowlist', async ({
    assert,
  }) => {
    const ctx = context()
    const result = await executeManagedSocial(
      'auth.methods',
      ctx,
      {} as SocialAuthentication,
      guard(),
      {
        ...social,
        lastUsedMethod: async () => 'unexpected' as 'password',
      }
    )
    assert.deepEqual(result, {
      status: 200,
      body: { providers: ['google'], lastUsedMethod: null },
    })
  })

  test('token redemption records only the provider returned by validated handoff', async ({
    assert,
  }) => {
    const ctx = context({ code: 'handoff-code', verifier: 'v'.repeat(43), provider: 'github' })
    let remembered: string | null = null
    const service = {
      redeemHandoff: async () => ({
        provider: 'google',
        account: { id: 7, active: true },
        credential: { opaque: 'issued-token' },
      }),
    } as unknown as SocialAuthentication
    const result = await executeManagedSocial(
      'auth.oauth.token',
      ctx,
      service,
      guard('access_tokens'),
      {
        ...social,
        rememberLastUsedMethod: async (_context, method) => {
          remembered = method
        },
      }
    )
    assert.deepEqual(result, {
      status: 200,
      body: { account: { id: 7, active: true }, token: 'issued-token' },
    })
    assert.equal(remembered, 'google')
    remembered = null
    await executeManagedSocial(
      'auth.oauth.token',
      context({ code: 'another-code', verifier: 'v'.repeat(43) }),
      service,
      guard('access_tokens'),
      {
        ...social,
        rememberLastUsedMethod: async (_context, method) => {
          remembered = method
        },
      },
      false
    )
    assert.isNull(remembered)
  })
})
