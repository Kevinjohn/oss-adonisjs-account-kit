import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Kernel } from '@adonisjs/core/ace'
import { test } from '@japa/runner'
import { bootTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'

if (process.env.TEST_BUILT_EXPORTS === '1')
  test('loads every built public export and resolves the built class through the built provider', async ({
    assert,
  }) => {
    const root = await import('adonisjs-account-kit')
    const types = await import('adonisjs-account-kit/types')
    const errors = await import('adonisjs-account-kit/errors')
    const provider = await import('adonisjs-account-kit/account_kit_provider')
    const legacyProvider = await import('adonisjs-account-kit/providers/account_kit_provider')
    const adapter = await import('adonisjs-account-kit/adapters/lucid')
    const sql = await import('adonisjs-account-kit/adapters/sql')
    const drizzle = await import('adonisjs-account-kit/adapters/drizzle')
    const prisma = await import('adonisjs-account-kit/adapters/prisma')
    const contract = await import('adonisjs-account-kit/testing/adapter_contract')
    const commands = await import('adonisjs-account-kit/commands')
    const http = await import('adonisjs-account-kit/http')
    const ally = await import('adonisjs-account-kit/ally')
    const capture = await import('adonisjs-account-kit/testing/notifications')
    const admission = await import('adonisjs-account-kit/admission')
    const admissionProvider = await import('adonisjs-account-kit/admission/provider')
    const admissionCommands = await import('adonisjs-account-kit/admission/commands')
    assert.isFunction(root.AccountKit)
    assert.isFunction(root.defineConfig)
    assert.isFunction(root.configure)
    assert.isFunction(root.createAllySocialProvider)
    assert.equal(ally.createAllySocialProvider, root.createAllySocialProvider)
    assert.lengthOf(Object.keys(types), 0)
    assert.isFunction(errors.ThrottledError)
    assert.equal(root.errors.ThrottledError, errors.ThrottledError)
    assert.equal(root.ThrottledError, errors.ThrottledError)
    assert.isFunction(provider.default)
    assert.equal(legacyProvider.default, provider.default)
    assert.isFunction(adapter.createLucidAdapter)
    assert.isFunction(sql.createSqlUsersAdapter)
    assert.isFunction(drizzle.createDrizzleAdapter)
    assert.isFunction(prisma.createPrismaAdapter)
    assert.isFunction(contract.assertUsersAdapterContract)
    assert.isFunction(capture.captureNotifications)
    assert.isFunction(root.createLogNotifications)
    assert.isFunction(commands.getMetaData)
    assert.isFunction(commands.getCommand)
    assert.isFunction(http.registerManagedRoutes)
    assert.isFunction(http.createManagedGuard)
    assert.isFunction(admission.defineAdmission)
    assert.isFunction(admission.AccountAdmission)
    assert.isFunction(admission.admissionMiddleware)
    assert.isFunction(admission.withInvitationEvidence)
    assert.isFunction(admission.withAdmissionCleanup)
    assert.instanceOf(new admission.AdmissionDecisionError(), root.AccountKitError)
    assert.isFunction(admissionProvider.default)
    const admissionCommandList = await admissionCommands.getMetaData()
    assert.includeMembers(
      admissionCommandList.map((command) => command.commandName),
      ['account-kit:admission:approve', 'account-kit:admission:revoke']
    )
    const built = await bootTestApp({ accountKitProvider: 'build' })
    try {
      await resetSchema(built)
      await built.limiter.clear()
      built.app.config.set(
        'account_kit',
        root.defineConfig(makeConfig({ users: makeUsersAdapter(built.db, built.hash) }))
      )
      const first = await built.app.container.make(root.AccountKit)
      const second = await built.app.container.make(root.AccountKit)
      assert.equal(first, second)
      assert.instanceOf(first, root.AccountKit)
      const service = await import('adonisjs-account-kit/services/main')
      assert.equal(service.default, first)

      new admissionProvider.default(built.app).register()
      built.app.config.set(
        'admission',
        admission.defineAdmission({ invitation: { required: true } })
      )
      const gate = await built.app.container.make(admission.AccountAdmission)
      assert.equal(gate.kit, first)

      const metadata = await commands.getMetaData()
      const pruneMetadata = metadata.find((item) => item.commandName === 'account-kit:prune')
      assert.isDefined(pruneMetadata)
      const pruneCommand = await commands.getCommand(pruneMetadata!)
      assert.isNotNull(pruneCommand)
      const ace = new Kernel(built.app)
      ace.addLoader(commands as never)
      await ace.handle(['account-kit:prune', '--dry-run'])
    } finally {
      await built.close()
    }
  })

/** Every built module `entry` reaches through relative static imports, including itself. */
async function reachable(entry: string): Promise<Set<string>> {
  const seen = new Set<string>()
  const pending = [resolve(entry)]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g))
      pending.push(resolve(dirname(file), match[1]))
  }
  return seen
}

if (process.env.TEST_BUILT_EXPORTS === '1')
  test('the built root entry never reaches the admission module', async ({ assert }) => {
    const build = fileURLToPath(new URL('../build/', import.meta.url))
    const rootFiles = await reachable(join(build, 'index.js'))
    const admissionFiles = await reachable(join(build, 'src/admission/main.js'))
    assert.isAbove(rootFiles.size, 1)
    const admissionOnly = [...admissionFiles].filter((file) => !rootFiles.has(file))
    assert.isNotEmpty(admissionOnly)
    const leaked: string[] = []
    for (const file of rootFiles) {
      if (file.includes('/src/admission/')) leaked.push(file)
      else {
        const source = await readFile(file, 'utf8')
        if (source.includes('account_admissions')) leaked.push(file)
      }
    }
    assert.deepEqual(leaked, [])
  })
