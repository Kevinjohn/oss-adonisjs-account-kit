import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { parseSetupChoices } from '../src/setup/parse.js'
import { cleanupRoots, fixture, registerSetupTeardown } from './helpers/setup_project_fixture.js'

test.group('setup apply', (group) => {
  registerSetupTeardown(group)

  test('refuses every differing file before writing any planned file', async ({ assert }) => {
    const { root, choices } = await fixture()
    await writeFile(join(root, '.env.account-kit.example'), 'owner value\n')
    const state = await inspectSetup(root)
    const plan = await planSetup(choices, state, { apply: true, timestamp: 1234 })
    assert.include(
      plan.diagnostics.map(({ field }) => field),
      '.env.account-kit.example'
    )
    await assert.rejects(() => applySetup(root, plan), /Setup has blocking diagnostics/)
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
    assert.equal(await readFile(join(root, '.env.account-kit.example'), 'utf8'), 'owner value\n')
  })

  test('replays an interrupted run and leaves application files untouched', async ({ assert }) => {
    const { root, choices } = await fixture()
    const originalRoutes = await readFile(join(root, 'start/routes.ts'), 'utf8')
    const first = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(first.diagnostics.some(({ severity }) => severity === 'error'))
    await writeFile(join(root, first.changes[0].path), first.changes[0].content)
    const resumed = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.equal(resumed.changes[0].action, 'unchanged')
    const written = await applySetup(root, resumed)
    assert.lengthOf(written, 23)
    assert.include(await readFile(join(root, 'start/routes.ts'), 'utf8'), originalRoutes.trim())
    assert.include(
      await readFile(join(root, 'start/routes.ts'), 'utf8'),
      "import './account_kit_routes.js'"
    )
    const repeated = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 4321,
    })
    assert.isTrue(repeated.changes.every(({ action }) => action === 'unchanged'))
    assert.deepEqual(await applySetup(root, repeated), [])
  })

  test('plans and applies a stock schema-composed starter with inert routes until application revocation is verified', async ({
    assert,
  }) => {
    const { root } = await fixture()
    const choices = parseSetupChoices(
      JSON.parse(
        await readFile(
          new URL('./fixtures/native_starter/setup-choices.json', import.meta.url),
          'utf8'
        )
      )
    )
    const stock = (path: string) =>
      readFile(new URL(`./fixtures/native_starter/${path}.fixture`, import.meta.url), 'utf8')
    for (const path of [
      'config/auth.ts',
      'config/mail.ts',
      'config/limiter.ts',
      'app/models/user.ts',
      'database/schema.ts',
    ]) {
      await mkdir(join(root, path.substring(0, path.lastIndexOf('/'))), { recursive: true })
      await writeFile(join(root, path), await stock(path))
    }
    await writeFile(join(root, '.env'), 'MAIL_MAILER=smtp\nLIMITER_STORE=database\n')
    await mkdir(join(root, 'node_modules/@adonisjs/mail'), { recursive: true })
    await writeFile(
      join(root, 'node_modules/@adonisjs/mail/package.json'),
      JSON.stringify({ name: '@adonisjs/mail', version: '10.0.0' })
    )
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    manifest.dependencies['@adonisjs/mail'] = '10'
    manifest.imports = { '#models/*': './app/models/*.js', '#database/*': './database/*.js' }
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      plan.diagnostics.some(({ severity }) => severity === 'error'),
      JSON.stringify(plan.diagnostics)
    )
    assert.isTrue(
      plan.diagnostics.some(
        ({ field, severity }) =>
          field === 'authentication.applicationRouteRevocation' && severity === 'action'
      )
    )
    assert.deepEqual(plan.endpointLocations, [])
    assert.isFalse(
      plan.changes
        .find(({ path }) => path === 'start/account_kit_routes.ts')
        ?.content.includes('registerManagedRoutes(')
    )
    await applySetup(root, plan)
    assert.notInclude(
      await readFile(join(root, 'start/account_kit_routes.ts'), 'utf8'),
      'registerManagedRoutes('
    )
    const replay = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      replay.diagnostics.some(({ severity }) => severity === 'error'),
      JSON.stringify(replay.diagnostics)
    )
    assert.isTrue(replay.changes.every(({ action }) => action === 'unchanged'))
    assert.deepEqual(await applySetup(root, replay), [])
    const activeChoices = structuredClone(choices)
    activeChoices.authentication!.applicationRouteRevocation = true
    const activation = await planSetup(activeChoices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      activation.diagnostics.some(({ severity }) => severity === 'error'),
      JSON.stringify(activation.diagnostics)
    )
    assert.include(
      activation.changes.find(({ path }) => path === 'start/account_kit_routes.ts')?.content,
      'registerManagedRoutes('
    )
    assert.equal(
      activation.changes.find(({ path }) => path === 'start/account_kit_routes.ts')?.action,
      'update'
    )
    await applySetup(root, activation)
    assert.include(
      await readFile(join(root, 'start/account_kit_routes.ts'), 'utf8'),
      'registerManagedRoutes('
    )
    assert.isFalse(activation.readiness.workflowVerified)
    const tokenChoices = structuredClone(activeChoices)
    tokenChoices.authentication = {
      strategy: 'access_tokens',
      guard: 'api',
      token: { revocation: true, lifetime: '1d', abilities: ['*'] },
      applicationRouteRevocation: true,
    }
    const tokenPlan = await planSetup(tokenChoices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      tokenPlan.diagnostics.some(({ severity }) => severity === 'error'),
      JSON.stringify(tokenPlan.diagnostics)
    )
  })

  test('a conflict introduced after planning still stops before the first write', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    const last = plan.changes.find(({ path }) => path.includes('_account_kit_'))!
    await mkdir(join(root, 'database/migrations'), { recursive: true })
    await writeFile(join(root, last.path), '// owner changed this migration\n')
    await assert.rejects(() => applySetup(root, plan), /Setup conflict/)
    assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
    assert.equal(await readFile(join(root, last.path), 'utf8'), '// owner changed this migration\n')
  })

  test('apply rejects a destination symlink before writing and preserves its target', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'account-setup-leaf-target-'))
    cleanupRoots.push(outside)
    const external = join(outside, 'owner.txt')
    const plan = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(plan.diagnostics.some(({ severity }) => severity === 'error'))
    const change = plan.changes.find(({ path }) => path === 'config/account_kit_setup.json')!
    assert.equal(change.action, 'create')
    const linked = join(root, change.path)
    await writeFile(external, change.content)
    await symlink(external, linked)
    const before = await readdir(join(root, 'config'))
    await assert.rejects(() => applySetup(root, plan), /non-regular file/)
    assert.deepEqual(await readdir(join(root, 'config')), before)
    const linkedStat = await lstat(linked)
    assert.isTrue(linkedStat.isSymbolicLink())
    assert.equal(await readlink(linked), external)
    assert.equal(await readFile(external, 'utf8'), change.content)
    assert.notInclude(await readdir(root), '.account-kit-setup.lock')
  })

  test('temporary write failure stays unpublished and a competing create is never replaced', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const ordinary = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    const target = 'app/atomic_account_kit_probe.txt'
    const plan = {
      ...ordinary,
      changes: [
        {
          path: target,
          action: 'create' as const,
          content: 'complete content\n',
          reason: 'Exercise atomic publication',
        },
      ],
    }
    await assert.rejects(
      () =>
        applySetup(root, plan, {
          beforePublish: async (temp) => {
            await writeFile(temp, 'partial')
            throw new Error('injected interruption')
          },
        }),
      /injected interruption/
    )
    const appFiles = await readdir(join(root, 'app'))
    assert.notInclude(appFiles, 'atomic_account_kit_probe.txt')
    assert.isFalse(appFiles.some((name) => name.includes('.account-kit-')))
    await assert.rejects(
      () =>
        applySetup(root, plan, {
          beforePublish: async (_temp, destination) => {
            await writeFile(destination, 'owner content\n')
          },
        }),
      /EEXIST/
    )
    assert.equal(await readFile(join(root, target), 'utf8'), 'owner content\n')
  })

  test('persisted named exclusion supports an application-owned replacement across preview, apply and check', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.managedExcept = ['auth.passwordReset.request']
    await writeFile(
      join(root, 'start/routes.ts'),
      "import router from '@adonisjs/core/services/router'\nrouter.post('/account/auth/password-reset', handler)\n"
    )
    const preview = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    assert.notInclude(
      preview.diagnostics.map(({ field }) => field),
      'routePrefix'
    )
    assert.notInclude(preview.endpoints, 'auth.passwordReset.request')
    assert.include(preview.endpoints, 'auth.passwordReset.inspect')
    const applied = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    await applySetup(root, applied)
    const persisted = await inspectSetup(root)
    assert.deepEqual(persisted.existingChoices?.managedExcept, ['auth.passwordReset.request'])
    assert.include(
      persisted.files['start/account_kit_routes.ts'],
      'except: ["auth.passwordReset.request"]'
    )
    const checked = await planSetup(persisted.existingChoices!, persisted, { timestamp: 1234 })
    assert.isFalse(checked.diagnostics.some(({ severity }) => severity === 'error'))
    assert.isTrue(checked.changes.every(({ action }) => action === 'unchanged'))
    choices.managedExcept = ['auth.passwordReset.request', 'auth.passwordReset.request']
    const invalid = await planSetup(choices, persisted)
    assert.include(
      invalid.diagnostics.map(({ field }) => field),
      'managedExcept'
    )
  })

  test('reconfiguration reports changed fields and updates only owned files', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const initial = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    await applySetup(root, initial)
    const routesBefore = await readFile(join(root, 'start/routes.ts'), 'utf8')
    choices.routePrefix = '/members'
    const next = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 4321,
    })
    assert.include(next.differences, 'routePrefix')
    assert.equal(
      next.changes.find(({ path }) => path === 'config/account_kit_setup.json')!.action,
      'update'
    )
    assert.equal(
      next.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.action,
      'update'
    )
    await applySetup(root, next)
    assert.equal(await readFile(join(root, 'start/routes.ts'), 'utf8'), routesBefore)
    assert.include(await readFile(join(root, 'start/account_kit_routes.ts'), 'utf8'), '"/members"')
  })

  test('disabling the last managed group retires its mount while keeping application routes', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const initial = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    await applySetup(root, initial)
    const routesBefore = await readFile(join(root, 'start/routes.ts'), 'utf8')
    choices.managed = []
    const next = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    const mount = next.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!
    assert.equal(mount.action, 'update')
    assert.notInclude(mount.content, 'registerManagedRoutes')
    await applySetup(root, next)
    assert.equal(await readFile(join(root, 'start/routes.ts'), 'utf8'), routesBefore)
    assert.equal(await readFile(join(root, 'start/account_kit_routes.ts'), 'utf8'), mount.content)
    assert.deepEqual(next.endpoints, [])
    choices.managed = ['passwordReset']
    choices.authentication!.guard = 'api'
    choices.authentication!.strategy = 'access_tokens'
    delete choices.authentication!.session
    choices.authentication!.token = { revocation: true, lifetime: '7d', abilities: ['*'] }
    const enabled = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.equal(
      enabled.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.action,
      'update'
    )
    await applySetup(root, enabled)
    assert.include(
      await readFile(join(root, 'start/account_kit_routes.ts'), 'utf8'),
      'registerManagedRoutes'
    )
  })

  test('disabled choices retain exact owned baselines through re-enable and reject edits', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.features.push('emailVerification')
    choices.mail.destinations.emailVerification = 'account/verify'
    await applySetup(
      root,
      await planSetup(choices, await inspectSetup(root), { apply: true, timestamp: 1234 })
    )
    choices.managed = []
    choices.policy.verificationRequired = true
    choices.authentication!.guard = 'api'
    choices.authentication!.strategy = 'access_tokens'
    delete choices.authentication!.session
    choices.authentication!.token = { revocation: true, lifetime: '1d', abilities: ['*'] }
    const disabled = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.equal(
      disabled.changes.find(({ path }) => path === 'app/services/account_kit_guard.ts')?.action,
      'update'
    )
    assert.equal(
      disabled.changes.find(
        ({ path }) => path === 'app/middleware/account_kit_access_middleware.ts'
      )?.action,
      'update'
    )
    await applySetup(root, disabled)
    choices.managed = ['passwordReset']
    const restored = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(restored.diagnostics.some(({ severity }) => severity === 'error'))
    await applySetup(root, restored)
    choices.managed = []
    choices.authentication = null
    const zero = { inspectedAccounts: 1, affectedAccounts: 0, checkedAt: new Date().toISOString() }
    await applySetup(
      root,
      await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
        retirementImpact: zero,
        retirementMaintenanceWindow: true,
      })
    )
    choices.authentication = {
      strategy: 'access_tokens',
      guard: 'api',
      token: { revocation: true, lifetime: '1d', abilities: ['*'] },
      applicationRouteRevocation: true,
    }
    choices.managed = ['passwordReset']
    const reenabling = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(reenabling.diagnostics.some(({ severity }) => severity === 'error'))
    await applySetup(root, reenabling)
    await writeFile(join(root, 'app/services/account_kit_guard.ts'), '// owner edit\n')
    choices.authentication.guard = 'web'
    const conflicted = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.equal(
      conflicted.changes.find(({ path }) => path === 'app/services/account_kit_guard.ts')?.action,
      'conflict'
    )
  })

  test('reconfiguration replay keeps old choices until dependent files finish', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    await applySetup(
      root,
      await planSetup(choices, await inspectSetup(root), { apply: true, timestamp: 1234 })
    )
    choices.routePrefix = '/new-account'
    const proposed = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.equal(proposed.changes.at(-1)?.path, 'config/account_kit_setup.json')
    await applySetup(root, { ...proposed, changes: proposed.changes.slice(0, 2) })
    const retry = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(retry.diagnostics.some(({ severity }) => severity === 'error'))
    await applySetup(root, retry)
    assert.equal(
      JSON.parse(await readFile(join(root, 'config/account_kit_setup.json'), 'utf8')).routePrefix,
      '/new-account'
    )
  })

  test('inspection refuses linked parent paths and setup refuses an existing apply lock', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'account-outside-'))
    cleanupRoots.push(outside)
    await rm(join(root, 'app/models'), { recursive: true })
    await symlink(outside, join(root, 'app/models'))
    await assert.rejects(
      async () => planSetup(choices, await inspectSetup(root)),
      /non-directory or symlink/
    )
    const other = await fixture()
    const plan = await planSetup(other.choices, await inspectSetup(other.root), {
      apply: true,
      timestamp: 1234,
    })
    await writeFile(join(other.root, '.account-kit-setup.lock'), 'held elsewhere\n')
    await assert.rejects(() => applySetup(other.root, plan), /already applying or was interrupted/)
    assert.notInclude(await readdir(join(other.root, 'config')), 'account_kit_setup.json')
    const migration = await fixture()
    await mkdir(join(migration.root, 'database'))
    await symlink(outside, join(migration.root, 'database/migrations'))
    await assert.rejects(() => inspectSetup(migration.root), /non-directory or symlink/)
  })
})
