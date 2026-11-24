// An `@adonisjs/auth` session guard that authenticates through Account Kit.
import { errors, type symbols } from '@adonisjs/auth'
import { SessionGuard } from '@adonisjs/auth/session'
import type { AuthClientResponse, GuardConfigProvider } from '@adonisjs/auth/types'
import type { SessionUserProviderContract } from '@adonisjs/auth/types/session'
import type { HttpContext } from '@adonisjs/core/http'
import type { ApplicationService, ConfigProvider } from '@adonisjs/core/types'
import { requireAccountAccessDecision } from '../account_access_decision.js'
import { buildAccountProjection } from '../account_projection.js'
import { requireAuthentication } from '../authentication_config.js'
import { establishCredential } from '../credential_issuance.js'
import { revision } from '../credential_revision.js'
import { lockUser, transaction } from '../db.js'
import {
  E_ACCOUNT_KIT_CREDENTIAL_ISSUANCE_REJECTED,
  E_ACCOUNT_KIT_CREDENTIALS_ACCOUNT_UNAVAILABLE,
  E_ACCOUNT_KIT_CREDENTIALS_ACCESS_DENIED,
  E_ACCOUNT_KIT_INVALID_SESSION,
} from '../errors.js'
import { createSessionGuard } from '../http/managed_session_guard.js'
import type { AuthenticationGuard, CurrentAccountInput, UserId } from '../types.js'

type RealUser<P extends SessionUserProviderContract<unknown>> = P[typeof symbols.PROVIDER_REAL_USER]

const revisionKey = 'accountKitRevision'
const handleKey = 'accountKitSession'

/**
 * A session guard for `config/auth.ts` that authenticates through Account Kit: the session must
 * hold a live registry handle and the current credential revision, exactly as
 * `authentication.current` checks. `ctx.auth.use(name).user` and `ctx.auth.user` are the
 * signed-in model; `authenticateAsClient(user)` creates a real registry sign-in, so
 * `@adonisjs/auth`'s `authApiClient` provides `loginAs`.
 *
 * @example
 * ```ts
 * import type { AccountKitSessionGuard } from '@kevinjohn/adonisjs-account-kit/auth'
 *
 * const web: AccountKitSessionGuard<typeof userProvider> = auth.use('web')
 * const user = await web.authenticate()
 * ```
 */
export class AccountKitSessionGuard<
  UserProvider extends SessionUserProviderContract<unknown>,
> extends SessionGuard<false, UserProvider> {
  readonly #name: string
  readonly #ctx: HttpContext
  readonly #provider: UserProvider
  readonly #app: ApplicationService

  constructor(
    name: string,
    ctx: HttpContext,
    emitter: ConstructorParameters<typeof SessionGuard<false, UserProvider>>[3],
    provider: UserProvider,
    app: ApplicationService
  ) {
    super(name, ctx, { useRememberMeTokens: false }, emitter, provider)
    this.#name = name
    this.#ctx = ctx
    this.#provider = provider
    this.#app = app
  }

  #createManagedGuard() {
    return createSessionGuard({
      strategy: 'session',
      name: this.#name,
      loadUser: async () => ({
        findOrFail: async (id: UserId) => {
          const user = await this.#provider.findById(id)
          if (!user) throw new E_ACCOUNT_KIT_INVALID_SESSION()
          return user.getOriginal()
        },
      }),
    })
  }

  /**
   * Authenticates the session as `SessionGuard` does, then checks its credential revision and
   * registry handle as `authentication.current` does. Fails with `E_UNAUTHORIZED_ACCESS`.
   *
   * @throws {AggregateError} Transaction work and cleanup both failed. The work failure is first.
   *
   * @example
   * ```ts
   * const user = await guard.authenticate()
   * ```
   */
  async authenticate(): Promise<RealUser<UserProvider>> {
    if (this.authenticationAttempted) return this.getUserOrFail()
    const user = await super.authenticate()
    // `SessionGuard.authenticate` has already required a session.
    const { session } = this.#ctx as HttpContext & { session: { get(key: string): unknown } }
    const stored = session.get(revisionKey)
    const handle = session.get(handleKey)
    try {
      if (stored !== undefined && typeof stored !== 'string')
        throw new E_ACCOUNT_KIT_INVALID_SESSION()
      if (handle !== undefined && typeof handle !== 'string')
        throw new E_ACCOUNT_KIT_INVALID_SESSION()
      const kit = await this.#app.container.make('account_kit')
      await kit.authentication.current({
        userId: (user as { id: UserId }).id,
        ...(stored === undefined ? {} : { revision: stored === '' ? null : stored }),
        ...(handle ? { sessionHandle: handle } : {}),
      })
    } catch (error) {
      // `SessionGuard.authenticate` marked the request authenticated before the kit check.
      this.user = undefined
      this.isAuthenticated = false
      if (!(error instanceof E_ACCOUNT_KIT_INVALID_SESSION)) throw error
      throw new errors.E_UNAUTHORIZED_ACCESS('Invalid or expired user session', {
        guardDriverName: this.driverName,
      })
    }
    return user
  }

  /**
   * Creates a registry sign-in for `user`, with the `canAccess` checks of `authentication.login`
   * after its password check, and returns the session data for the test client.
   *
   * @throws {AggregateError} Account work or credential issuance and its cleanup both failed. The primary failure is first.
   *
   * @example
   * ```ts
   * const { session } = await guard.authenticateAsClient(user)
   * ```
   */
  async authenticateAsClient(user: RealUser<UserProvider>): Promise<AuthClientResponse> {
    const guardUser = await this.#provider.createUserForGuard(user)
    const userId = guardUser.getId() as UserId
    const kit = await this.#app.container.make('account_kit')
    const deps = kit['deps']
    const auth = requireAuthentication(deps.config)
    const verified = await transaction(deps.db, async (trx) => {
      await lockUser(trx, deps.config, userId)
      const account = await deps.config.users.findById(userId, trx)
      if (!account) throw new E_ACCOUNT_KIT_CREDENTIALS_ACCOUNT_UNAVAILABLE()
      if (!requireAccountAccessDecision(await auth.canAccess(account, trx)))
        throw new E_ACCOUNT_KIT_CREDENTIALS_ACCESS_DENIED()
      return {
        account: buildAccountProjection(account),
        revision: await revision(trx, deps.config, account.id),
      }
    })
    const session: Record<string, unknown> = {}
    const sessionKey = this.sessionKeyName
    await establishCredential(
      deps,
      auth,
      {
        strategy: 'session',
        name: this.#name,
        async establish(id, stamp, handle) {
          session[sessionKey] = id
          session[revisionKey] = stamp ?? ''
          if (handle) session[handleKey] = handle
        },
        async terminate() {},
      },
      verified,
      {
        rejected: () => new E_ACCOUNT_KIT_CREDENTIAL_ISSUANCE_REJECTED(),
        cleanupFailed: 'Client sign-in failed',
      }
    )
    return { session }
  }

  /**
   * The verified sign-in for `authentication.current` / `withCurrent`; `ManagedGuard.current` without a context.
   *
   * @throws {AggregateError} Transaction work and cleanup both failed. The work failure is first.
   *
   * @example
   * ```ts
   * const account = await kit.authentication.current(await guard.current())
   * ```
   */
  current(): Promise<CurrentAccountInput> {
    return this.#createManagedGuard().current(this.#ctx)
  }

  /**
   * The request adapter for `authentication.login` / `logout`; `ManagedGuard.forRequest` without a context.
   *
   * @example
   * ```ts
   * const current = await guard.current()
   * await kit.authentication.logout(guard.forRequest(), undefined, current)
   * ```
   */
  forRequest(): AuthenticationGuard<undefined> {
    return this.#createManagedGuard().forRequest(this.#ctx)
  }
}

/**
 * Configures an `AccountKitSessionGuard` in `config/auth.ts`, as `sessionGuard` does.
 *
 * @example
 * ```ts
 * import { accountKitSessionGuard } from '@kevinjohn/adonisjs-account-kit/auth'
 * import { defineConfig } from '@adonisjs/auth'
 * import { sessionUserProvider } from '@adonisjs/auth/session'
 *
 * export default defineConfig({
 *   default: 'web',
 *   guards: {
 *     web: accountKitSessionGuard({
 *       provider: sessionUserProvider({ model: () => import('#models/user') }),
 *     }),
 *   },
 * })
 * ```
 */
export function accountKitSessionGuard<
  UserProvider extends SessionUserProviderContract<unknown>,
>(config: {
  provider: UserProvider | ConfigProvider<UserProvider>
}): GuardConfigProvider<(ctx: HttpContext) => AccountKitSessionGuard<UserProvider>> {
  return {
    async resolver(name, app) {
      const emitter = await app.container.make('emitter')
      const provider =
        'resolver' in config.provider ? await config.provider.resolver(app) : config.provider
      return (ctx) => new AccountKitSessionGuard(name, ctx, emitter as never, provider, app)
    },
  }
}
