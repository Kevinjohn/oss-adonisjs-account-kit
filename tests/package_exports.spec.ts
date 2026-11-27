import { DateTime } from 'luxon'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Kernel } from '@adonisjs/core/ace'
import { test } from '@japa/runner'
import type { AccountKitCommandsLoader } from '../src/types_commands.ts'
import { bootTestApp } from './helpers/app.ts'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.ts'
import { resetSchema } from './helpers/schema.ts'

if (process.env.TEST_BUILT_EXPORTS === '1')
  test('loads every built public export and resolves the built class through the built provider', async ({
    assert,
    expectTypeOf,
  }) => {
    const root = await import('@kevinjohn/adonisjs-account-kit')
    const types = await import('@kevinjohn/adonisjs-account-kit/types')
    const authTypesPath = '@kevinjohn/adonisjs-account-kit/types/auth'
    const authTypes = await import(authTypesPath)
    const errors = await import('@kevinjohn/adonisjs-account-kit/errors')
    const provider = await import('@kevinjohn/adonisjs-account-kit/account_kit_provider')
    const adapter = await import('@kevinjohn/adonisjs-account-kit/adapters/lucid')
    const sql = await import('@kevinjohn/adonisjs-account-kit/adapters/sql')
    const drizzle = await import('@kevinjohn/adonisjs-account-kit/adapters/drizzle')
    const prisma = await import('@kevinjohn/adonisjs-account-kit/adapters/prisma')
    const contract = await import('@kevinjohn/adonisjs-account-kit/testing/adapter_contract')
    const commands = await import('@kevinjohn/adonisjs-account-kit/commands')
    const defineCommands = await import('@kevinjohn/adonisjs-account-kit/define_commands')
    const auth = await import('@kevinjohn/adonisjs-account-kit/auth')
    const http = await import('@kevinjohn/adonisjs-account-kit/http')
    const transactionHelpers = await import('@kevinjohn/adonisjs-account-kit/transaction')
    const ally = await import('@kevinjohn/adonisjs-account-kit/ally')
    const capture = await import('@kevinjohn/adonisjs-account-kit/testing/notifications')
    const admission = await import('@kevinjohn/adonisjs-account-kit/admission')
    const admissionProvider = await import('@kevinjohn/adonisjs-account-kit/admission/provider')
    assert.isFunction(root.AccountKit)
    assert.isFunction(root.defineConfig)
    assert.isFunction(root.AccountKitCallbackConfiguration)
    assert.isFunction(root.configure)
    assert.isFunction(root.createAllySocialProvider)
    assert.equal(ally.createAllySocialProvider, root.createAllySocialProvider)
    assert.lengthOf(Object.keys(types), 0)
    assert.lengthOf(Object.keys(authTypes), 0)
    for (const [name, Constructor] of Object.entries(errors)) {
      if (!name.startsWith('E_')) continue
      assert.equal(root.errors[name as keyof typeof root.errors], Constructor, name)
      assert.match(Constructor.name, /Exception$/)
    }
    assert.notProperty(root, 'InvalidTokenError')
    assert.notProperty(errors, 'InvalidTokenError')
    assert.equal(
      admission.E_ACCOUNT_KIT_ADMISSION_REQUIRED,
      root.errors.E_ACCOUNT_KIT_ADMISSION_REQUIRED
    )
    assert.equal(
      admission.E_ACCOUNT_KIT_ADMISSION_DECISION,
      root.errors.E_ACCOUNT_KIT_ADMISSION_DECISION
    )
    assert.isFunction(errors.E_ACCOUNT_KIT_THROTTLED)
    assert.equal(root.errors.E_ACCOUNT_KIT_THROTTLED, errors.E_ACCOUNT_KIT_THROTTLED)
    assert.equal(root.E_ACCOUNT_KIT_THROTTLED, errors.E_ACCOUNT_KIT_THROTTLED)
    assert.isFunction(provider.default)
    assert.notProperty(
      JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).exports,
      './providers/account_kit_provider'
    )
    const retiredProviderPath = '@kevinjohn/adonisjs-account-kit/providers/account_kit_provider'
    await assert.rejects(() => import(retiredProviderPath), /not defined by \"exports\"/)
    assert.isFunction(adapter.createLucidAdapter)
    assert.isFunction(sql.createSqlUsersAdapter)
    assert.isFunction(drizzle.createDrizzleAdapter)
    assert.isFunction(prisma.createPrismaAdapter)
    assert.isFunction(contract.usersAdapterContract)
    assert.isFunction(capture.captureNotifications)
    assert.isFunction(root.createLogNotifications)
    assert.isFunction(commands.getMetaData)
    assert.isFunction(commands.getCommand)
    expectTypeOf(commands.getMetaData).toEqualTypeOf<AccountKitCommandsLoader['getMetaData']>()
    expectTypeOf(commands.getCommand).toEqualTypeOf<AccountKitCommandsLoader['getCommand']>()
    assert.isFunction(defineCommands.defineCommands)
    assert.isFunction(auth.accountKitSessionGuard)
    assert.notProperty(http, 'ManagedRoutes')
    assert.isFunction(http.createManagedGuard)
    assert.isFunction(transactionHelpers.TransactionManager)
    assert.isFunction(transactionHelpers.sqlTimestamp)
    assert.isFunction(transactionHelpers.readTimestamp)
    assert.isFunction(admission.defineConfig)
    assert.isFunction(admission.AccountAdmission)
    assert.isFunction(admission.AdmissionCallbackConfiguration)
    for (const middleware of [
      await import('@kevinjohn/adonisjs-account-kit/middleware/admission'),
      await import('@kevinjohn/adonisjs-account-kit/middleware/managed_account'),
      await import('@kevinjohn/adonisjs-account-kit/middleware/proof_headers'),
    ])
      assert.isFunction(middleware.default.prototype.handle)
    assert.isFunction(admission.withInvitationEvidence)
    assert.isFunction(admission.withAdmissionCleanup)
    assert.instanceOf(new admission.E_ACCOUNT_KIT_ADMISSION_DECISION(), root.E_ACCOUNT_KIT)
    assert.isFunction(admissionProvider.default)
    const rootCommandList = await commands.getMetaData()
    assert.deepEqual(rootCommandList.map((command) => command.commandName).sort(), [
      'account-kit:admission:approve',
      'account-kit:admission:bootstrap',
      'account-kit:admission:grant-invitation',
      'account-kit:admission:install',
      'account-kit:admission:revoke',
      'account-kit:doctor',
      'account-kit:invite',
      'account-kit:openapi',
      'account-kit:prune',
      'account-kit:reset-link',
      'account-kit:retirement-impact',
      'account-kit:setup',
    ])
    for (const metadata of rootCommandList) {
      const command = await commands.getCommand(metadata)
      assert.equal(command?.commandName, metadata.commandName)
    }
    const filtered = await defineCommands.defineCommands({ exclude: ['account-kit:prune'] })()
    assert.deepEqual(
      await filtered.getMetaData(),
      rootCommandList.filter((command) => command.commandName !== 'account-kit:prune')
    )
    const built = await bootTestApp({ accountKitProvider: 'build' })
    try {
      await resetSchema(built)
      await built.limiter.clear()
      const transactions = new transactionHelpers.TransactionManager(built.db)
      const stamped = await transactions.run(async (trx) => {
        const [inserted] = await trx
          .table('users')
          .insert({
            email: 'built@example.test',
            password: null,
            created_at: transactionHelpers.sqlTimestamp(trx, DateTime.utc()),
          })
          .returning('id')
        const id = typeof inserted === 'object' ? inserted.id : inserted
        await transactions.lockRow(trx, 'users', id)
        return transactionHelpers.readTimestamp(
          transactionHelpers.sqlTimestamp(trx, DateTime.utc())
        )
      })
      assert.isTrue(stamped!.isValid)
      built.app.config.set(
        'account_kit',
        root.defineConfig(
          makeConfig({
            users: makeUsersAdapter(built.db, built.hash),
            authentication: { strategy: 'session', guard: 'web' },
          })
        )
      )
      const first = await built.app.container.make(root.AccountKit)
      const second = await built.app.container.make(root.AccountKit)
      assert.equal(first, second)
      assert.instanceOf(first, root.AccountKit)
      assert.isFunction(errors.E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED)
      assert.equal(
        root.E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED,
        errors.E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED
      )
      assert.equal(
        root.errors.E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED,
        errors.E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED
      )
      await assert.rejects(
        () => first.authentication.inspectAccountAccess({ userId: 999999, requireActive: true }),
        errors.E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED
      )
      const service = await import('@kevinjohn/adonisjs-account-kit/services/main')
      assert.equal(service.default, first)

      new admissionProvider.default(built.app).register()
      built.app.config.set('admission', admission.defineConfig({ invitation: { required: true } }))
      const gate = await built.app.container.make(admission.AccountAdmission)
      assert.equal(gate.kit, first)
      const services = {
        managedRoutes: await import('@kevinjohn/adonisjs-account-kit/services/managed_routes'),
        callbacks: await import('@kevinjohn/adonisjs-account-kit/services/callbacks'),
        admission: await import('@kevinjohn/adonisjs-account-kit/services/admission'),
        admissionCallbacks:
          await import('@kevinjohn/adonisjs-account-kit/services/admission_callbacks'),
      }
      assert.equal(
        services.managedRoutes.default,
        await built.app.container.make('account_kit.managed_routes')
      )
      assert.equal(
        services.callbacks.default,
        await built.app.container.make('account_kit.callbacks')
      )
      assert.equal(services.admission.default, gate)
      assert.equal(
        services.admissionCallbacks.default,
        await built.app.container.make('account_admission.callbacks')
      )

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

if (process.env.TEST_BUILT_EXPORTS === '1')
  test('compiles the optional auth type through its built public export', async ({ assert }) => {
    const { default: ts } = await import('typescript')
    const entry = fileURLToPath(new URL('../auth_types_consumer.ts', import.meta.url))
    const source = `import { accountKitSessionGuard } from '@kevinjohn/adonisjs-account-kit/auth'
import type { AccountKitSessionGuard } from '@kevinjohn/adonisjs-account-kit/types/auth'
import type { SessionUserProviderContract } from '@adonisjs/auth/types/session'
declare const guard: AccountKitSessionGuard<SessionUserProviderContract<unknown>>
const authenticated: Promise<unknown> = guard.authenticate()
void authenticated
void accountKitSessionGuard
`
    const options = {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ESNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    }
    const host = ts.createCompilerHost(options)
    const getSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
      file === entry
        ? ts.createSourceFile(file, source, languageVersion, true)
        : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
    const program = ts.createProgram([entry], options, host)
    assert.deepEqual(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
      []
    )
  }).timeout(30_000)
