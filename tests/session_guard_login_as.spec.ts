import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import AuthProvider from '@adonisjs/auth/auth_provider'
import { authApiClient } from '@adonisjs/auth/plugins/api_client'
import { defineConfig as defineAuthConfig, symbols, type Authenticator } from '@adonisjs/auth'
import { configProvider } from '@adonisjs/core'
import { CookieClient } from '@adonisjs/core/http'
import { defineConfig as defineSessionConfig } from '@adonisjs/session'
import type { ResolvedSessionConfig, SessionData } from '@adonisjs/session/types'
import SessionProvider from '@adonisjs/session/session_provider'
import { ApiClient, ApiRequest } from '@japa/api-client'
import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import { accountKitSessionGuard } from '../src/auth/session_guard.js'
import type { AccountUser } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeConfig, makeUsersAdapter } from './helpers/fakes.js'

declare module '@japa/api-client' {
  interface ApiRequest {
    withSession(data: SessionData): this
  }
}

// `loginAs` from `@adonisjs/auth`'s Japa plugin, through a real HTTP server, into the guard.
test.group('accountKitSessionGuard with loginAs', (group) => {
  const kit = useTestApp(group, { accountKitProvider: 'source' })
  let httpServer: Server | undefined
  let baseUrl: string

  group.setup(async () => {
    const { app } = kit
    const guardUser = (user: AccountUser) => ({ getId: () => user.id, getOriginal: () => user })
    const provider = {
      [symbols.PROVIDER_REAL_USER]: undefined as unknown as AccountUser,
      createUserForGuard: async (user: AccountUser) => guardUser(user),
      async findById(id: string | number | BigInt) {
        const user = await makeUsersAdapter(kit.db, kit.hash).findById(Number(id))
        return user ? guardUser(user) : null
      },
    }
    app.config.set(
      'account_kit',
      defineConfig(
        makeConfig({
          users: makeUsersAdapter(kit.db, kit.hash),
          enabled: ['sessionManagement'],
          authentication: { strategy: 'session', guard: 'web', canAccess: async () => true },
        })
      )
    )
    app.config.set('session', defineSessionConfig({ store: 'memory', stores: {} }))
    app.config.set(
      'auth',
      defineAuthConfig({ default: 'web', guards: { web: accountKitSessionGuard({ provider }) } })
    )
    new SessionProvider(app).register()
    new AuthProvider(app).register()

    const server = await app.container.make('server')
    const router = await app.container.make('router')
    // Specifiers in variables keep the middleware's `HttpContext` augmentations out of the
    // type program; other specs type `ctx.session` and `ctx.auth` themselves.
    const middleware = [
      '@adonisjs/session/session_middleware',
      '@adonisjs/auth/initialize_auth_middleware',
    ]
    server.use(middleware.map((specifier) => () => import(specifier)))
    router.get('/me', async (ctx) => {
      const { auth } = ctx as typeof ctx & { auth: Authenticator<never> }
      await auth.authenticateUsing(['web'])
      return { id: (auth.user as AccountUser).id }
    })
    await server.boot()
    const listening = createServer(server.handle.bind(server))
    httpServer = listening
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`

    // `sessionApiClient` imports `@japa/plugin-adonisjs`, which this package does not install.
    // This `withSession` does its part for `loginAs`: store the data, send the signed cookie.
    const sessionConfig = (await configProvider.resolve<ResolvedSessionConfig>(
      app,
      app.config.get('session')
    ))!
    const cookies = new CookieClient((await app.container.make('encryption')) as never)
    ApiRequest.macro('withSession', function (this: ApiRequest, data: SessionData) {
      const sessionId = randomUUID()
      const store = sessionConfig.stores[sessionConfig.store](null as never, sessionConfig)
      store.write(sessionId, data)
      return this.cookie(
        sessionConfig.cookieName,
        cookies.sign(sessionConfig.cookieName, sessionId)!
      )
    })
    await authApiClient(app)({} as never)
  })

  group.teardown(async () => {
    ApiClient.clearSetupHooks().clearTeardownHooks().clearRequestHandlers()
    await new Promise((resolve) => (httpServer ? httpServer.close(resolve) : resolve(null)))
  })

  test('loginAs signs in through the guard and the registry', async ({ assert }) => {
    const user = await insertUser(kit)
    // `loginAs` takes the default guard's arguments; this package declares no `Authenticators`.
    const request = new ApiClient(baseUrl, assert).get('/me') as ApiRequest & {
      loginAs(user: AccountUser): ApiRequest
    }
    const response = await request.loginAs(user)
    assert.equal(response.status(), 200, response.text())
    assert.deepEqual(response.body(), { id: user.id })
    assert.lengthOf(await kit.db.from('account_sessions').where('user_id', user.id), 1)
  })
})
