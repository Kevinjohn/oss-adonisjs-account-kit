import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { Kernel, ListLoader } from '@adonisjs/core/ace'
import { Router } from '@adonisjs/core/http'
import { defineConfig as defineSessionConfig } from '@adonisjs/session'
import ManagedOpenApi from '../commands/openapi.js'
import * as commandLoader from '../commands/main.js'
import type { AccountKit } from '../src/account_kit.js'
import { registerManagedRoutes } from '../src/http/managed.js'
import { useTestApp, type TestApp } from './helpers/app.js'
import { fixture } from './helpers/managed_http.js'
import { documentErrors } from './helpers/openapi.js'

function kernelFor(kit: TestApp, router: Router) {
  // `router` is an alias of the Router class, so the class binding is swapped.
  kit.app.container.swap(Router, () => router)
  const kernel = new Kernel(kit.app)
  kernel.addLoader(new ListLoader([ManagedOpenApi]))
  kernel.ui.switchMode('raw')
  const logs = () => kernel.ui.logger.getLogs() as Array<{ message: string; stream: string }>
  return { kernel, logs }
}

function mounted(options: { representAccount?: boolean } = {}) {
  const { router } = fixture()
  registerManagedRoutes(router, {
    prefix: '/api/v1',
    kit: async () => ({}) as AccountKit,
    guard: {
      strategy: 'session',
      name: 'web',
      forRequest: () => ({}) as never,
      current: async () => ({ userId: 1, revision: null }),
    },
    enabled: ['authentication', 'passwordReset'],
    extensions: options.representAccount ? { representAccount: () => ({}) } : {},
  })
  return router
}

test.group('account-kit:openapi', (group) => {
  const kit = useTestApp(group)
  group.each.teardown(() => kit.app.container.restore(Router))

  test('prints a valid document for the registered routes to stdout', async ({ assert }) => {
    const router = mounted()
    let commits = 0
    const commit = router.commit.bind(router)
    router.commit = () => {
      commits++
      commit()
    }
    kit.app.config.set(
      'session',
      defineSessionConfig({ cookieName: 'app-session', store: 'memory', stores: {} })
    )
    const { kernel, logs } = kernelFor(kit, router)
    const command = await kernel.exec('account-kit:openapi', [
      '--title=Accounts',
      '--api-version=4.2.0',
    ])
    assert.equal(command.exitCode ?? 0, 0)
    assert.equal(commits, 1)
    assert.lengthOf(logs(), 1)
    assert.equal(logs()[0].stream, 'stdout')
    const document = JSON.parse(logs()[0].message)
    assert.deepEqual(documentErrors(document), [])
    assert.deepEqual(document.info, { title: 'Accounts', version: '4.2.0' })
    assert.equal(document.components.securitySchemes.sessionCookie.name, 'app-session')
    assert.property(document.paths, '/api/v1/auth/password-reset')
    assert.notProperty(document.paths, '/api/v1/auth/signup')
  })

  test('defaults the title and version to the host package.json', async ({ assert }) => {
    const { kernel, logs } = kernelFor(kit, mounted())
    await kernel.exec('account-kit:openapi', [])
    const host = JSON.parse(
      await readFile(kit.app.makePath('package.json'), 'utf8').catch(() => '{}')
    )
    const document = JSON.parse(logs()[0].message)
    assert.deepEqual(document.info, {
      title: host.name ?? 'Account API',
      version: host.version ?? '0.0.0',
    })
  })

  test('writes the document to --output', async ({ assert, cleanup }) => {
    const directory = await mkdtemp(join(tmpdir(), 'account-kit-openapi-'))
    cleanup(() => rm(directory, { recursive: true, force: true }))
    const target = join(directory, 'openapi.json')
    const { kernel, logs } = kernelFor(kit, mounted())
    const command = await kernel.exec('account-kit:openapi', [`--output=${target}`])
    assert.equal(command.exitCode ?? 0, 0)
    const document = JSON.parse(await readFile(target, 'utf8'))
    assert.equal(document.openapi, '3.1.0')
    assert.include(logs()[0].message, target)
  })

  test('fails clearly without managed routes or without a needed schema', async ({ assert }) => {
    const empty = kernelFor(kit, fixture().router)
    const missing = await empty.kernel.exec('account-kit:openapi', [])
    assert.equal(missing.exitCode, 1)
    assert.equal(empty.logs()[0].stream, 'stderr')
    assert.include(empty.logs()[0].message, 'No Account Kit managed routes are registered')

    const represented = kernelFor(kit, mounted({ representAccount: true }))
    const failed = await represented.kernel.exec('account-kit:openapi', [])
    assert.equal(failed.exitCode, 1)
    assert.include(represented.logs()[0].message, 'openapi.accountSchema')
  })

  test('reads routes registered on the application router', async ({ assert }) => {
    const router = await kit.app.container.make('router')
    router.get('/health', () => 'ok')
    registerManagedRoutes(router, {
      prefix: '/accounts',
      kit: async () => ({}) as AccountKit,
      guard: {
        strategy: 'access_tokens',
        name: 'api',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, tokenId: 1 }),
        publicCredential: () => 'opaque',
      },
      enabled: ['passwordReset'],
    })
    const kernel = new Kernel(kit.app)
    kernel.addLoader(new ListLoader([ManagedOpenApi]))
    kernel.ui.switchMode('raw')
    await kernel.exec('account-kit:openapi', [])
    assert.isTrue(router.commited)
    const logs = kernel.ui.logger.getLogs() as Array<{ message: string }>
    const document = JSON.parse(logs[0].message)
    assert.deepEqual(Object.keys(document.paths), [
      '/accounts/auth/password-reset',
      '/accounts/auth/password-reset/{token}',
    ])
    assert.deepEqual(Object.keys(document.components.securitySchemes), ['bearerToken'])
  })

  test('the package command loader lists the command', async ({ assert }) => {
    const metadata = await commandLoader.getMetaData()
    const names = metadata.map((item) => item.commandName)
    assert.include(names, 'account-kit:openapi')
  })
})
