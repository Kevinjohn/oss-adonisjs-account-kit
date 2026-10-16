import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { fixture, registerSetupTeardown } from './helpers/setup.js'

test.group('setup social providers', (group) => {
  registerSetupTeardown(group)

  test('selected social providers produce exact callback URLs and credential references only for those providers', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.features = [
      'authentication',
      'registration',
      'emailVerification',
      'socialAuthentication',
    ]
    choices.managed = ['socialAuthentication']
    choices.policy.registration = 'open'
    choices.social = {
      status: 'enabled',
      providers: ['github'],
      callbackOriginEnv: 'ACCOUNT_SOCIAL_ORIGIN',
      callbackPath: '/account/auth/oauth/{provider}/callback',
      credentials: {
        github: { clientIdEnv: 'GITHUB_CLIENT_ID', clientSecretEnv: 'GITHUB_CLIENT_SECRET' },
      },
    }
    const plan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    assert.include(plan.endpoints, 'auth.oauth.callback')
    assert.include(plan.pillars.social, 'GitHub')
    assert.equal(
      plan.diagnostics.find(({ field }) => field === 'social.sensitiveActions')?.severity,
      'error'
    )
    assert.include(plan.prerequisites.join(' '), 'first-password reset')
    assert.include(plan.prerequisites.join(' '), '/account/auth/oauth/github/callback')
    const env = plan.changes.find(({ path }) => path === '.env.account-kit.example')!.content
    assert.include(env, 'GITHUB_CLIENT_ID=')
    assert.include(env, 'GITHUB_CLIENT_SECRET=')
    assert.notInclude(env, 'GOOGLE_CLIENT_SECRET=')
    assert.notInclude(env, 'github-client-secret-value')

    choices.features.push('passwordReset')
    const withFallback = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    const sessionHeaders = withFallback.changes.find(
      ({ path }) => path === 'app/middleware/account_kit_proof_headers_middleware.ts'
    )!.content
    assert.include(sessionHeaders, 'strategy: "session"')
    choices.authentication!.strategy = 'access_tokens'
    choices.authentication!.guard = 'api'
    delete choices.authentication!.session
    choices.authentication!.token = { revocation: true, lifetime: '7d', abilities: ['*'] }
    const tokenPlan = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    const tokenHeaders = tokenPlan.changes.find(
      ({ path }) => path === 'app/middleware/account_kit_proof_headers_middleware.ts'
    )!.content
    assert.include(tokenHeaders, 'strategy: "access_tokens"')
    choices.authentication!.strategy = 'session'
    choices.authentication!.guard = 'web'
    delete choices.authentication!.token
    choices.authentication!.session = {
      secureCookie: true,
      csrf: true,
      originChecked: true,
      persistentStore: true,
    }
    assert.notInclude(
      withFallback.diagnostics.map(({ field }) => field),
      'social.sensitiveActions'
    )
    await mkdir(join(root, 'node_modules/@adonisjs/ally'), { recursive: true })
    await writeFile(
      join(root, 'node_modules/@adonisjs/ally/package.json'),
      JSON.stringify({ name: '@adonisjs/ally', version: '5.9.0' })
    )
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    packageJson.dependencies['@adonisjs/ally'] = '5.9.0'
    await writeFile(join(root, 'package.json'), JSON.stringify(packageJson))
    const unsupportedAlly = await planSetup(choices, await inspectSetup(root), {
      timestamp: 1234,
    })
    assert.include(
      unsupportedAlly.diagnostics.find(({ field }) => field === 'dependencies.@adonisjs/ally')
        ?.message,
      'outside the verified range'
    )
    choices.managedExcept = ['auth.oauth.callback']
    const excluded = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    assert.notInclude(excluded.endpoints, 'auth.oauth.callback')
    assert.notInclude(
      excluded.endpointLocations.map(({ name }) => name),
      'auth.oauth.callback'
    )
    assert.include(
      excluded.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.content,
      'except: ["auth.oauth.callback"]'
    )
    choices.policy.registration = 'application'
    const application = await planSetup(choices, await inspectSetup(root), { timestamp: 1234 })
    assert.notInclude(application.endpoints, 'auth.oauth.registration')
    const mount = application.changes.find(
      ({ path }) => path === 'start/account_kit_routes.ts'
    )!.content
    assert.include(mount, 'except: ["auth.oauth.callback","auth.oauth.registration"]')
    assert.equal(mount.match(/except:/g)?.length, 1)
  })

  test('selected social setup rejects missing or invalid installed Ally version metadata', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.features = ['authentication', 'registration', 'socialAuthentication']
    choices.managed = ['socialAuthentication']
    choices.social = {
      status: 'enabled',
      providers: ['github'],
      callbackOriginEnv: 'ACCOUNT_SOCIAL_ORIGIN',
      callbackPath: '/account/auth/oauth/{provider}/callback',
      credentials: {
        github: { clientIdEnv: 'GITHUB_CLIENT_ID', clientSecretEnv: 'GITHUB_CLIENT_SECRET' },
      },
    }
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    packageJson.dependencies['@adonisjs/ally'] = '6.3.2'
    await writeFile(join(root, 'package.json'), JSON.stringify(packageJson))
    await mkdir(join(root, 'node_modules/@adonisjs/ally'), { recursive: true })
    await writeFile(
      join(root, 'node_modules/@adonisjs/ally/package.json'),
      JSON.stringify({ name: '@adonisjs/ally', version: '' })
    )
    const state = await inspectSetup(root)
    assert.include(state.installedPackages, '@adonisjs/ally')

    for (const version of ['', ' ', 'garbage', '6.3.1', '6.4.0']) {
      state.installedVersions['@adonisjs/ally'] = version
      const plan = await planSetup(choices, state, { timestamp: 1234 })
      assert.match(
        plan.diagnostics.find(({ field }) => field === 'dependencies.@adonisjs/ally')?.message ??
          '',
        /outside the verified range/,
        `Installed Ally version ${JSON.stringify(version)} must be rejected`
      )
    }
    delete state.installedVersions['@adonisjs/ally']
    const unknownVersion = await planSetup(choices, state, { timestamp: 1234 })
    assert.match(
      unknownVersion.diagnostics.find(({ field }) => field === 'dependencies.@adonisjs/ally')
        ?.message ?? '',
      /outside the verified range/
    )
    for (const version of ['6.3.2', '6.3.99']) {
      state.installedVersions['@adonisjs/ally'] = version
      const plan = await planSetup(choices, state, { timestamp: 1234 })
      assert.notInclude(
        plan.diagnostics.map(({ field }) => field),
        'dependencies.@adonisjs/ally',
        `Installed Ally version ${version} must be accepted`
      )
    }

    delete state.installedVersions['@adonisjs/ally']
    state.installedPackages = state.installedPackages.filter((name) => name !== '@adonisjs/ally')
    const missingPlan = await planSetup(choices, state, { timestamp: 1234 })
    assert.include(
      missingPlan.diagnostics.find(({ field }) => field === 'dependencies.@adonisjs/ally')?.message,
      'Install @adonisjs/ally explicitly'
    )
  })

  test('social setup keeps class proof headers and only mounts after revocation for both guards', async ({
    assert,
  }) => {
    for (const strategy of ['session', 'access_tokens'] as const) {
      const { root, choices } = await fixture()
      choices.features = [
        'authentication',
        'registration',
        'emailVerification',
        'passwordReset',
        'socialAuthentication',
      ]
      choices.managed = ['passwordReset', 'socialAuthentication']
      choices.managedExcept = ['auth.oauth.redirect']
      choices.policy.registration = 'open'
      choices.mail.destinations.emailVerification = 'account/verification'
      choices.social = {
        status: 'enabled',
        providers: ['github'],
        callbackOriginEnv: 'ACCOUNT_SOCIAL_ORIGIN',
        callbackPath: '/account/auth/oauth/{provider}/callback',
        credentials: {
          github: { clientIdEnv: 'GITHUB_CLIENT_ID', clientSecretEnv: 'GITHUB_CLIENT_SECRET' },
        },
      }
      if (strategy === 'access_tokens') {
        choices.authentication = {
          strategy,
          guard: 'api',
          token: { revocation: true, lifetime: '7d', abilities: ['*'] },
          applicationRouteRevocation: false,
        }
      } else choices.authentication!.applicationRouteRevocation = false
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
      manifest.dependencies['@adonisjs/ally'] = '6.3.2'
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
      await mkdir(join(root, 'node_modules/@adonisjs/ally'), { recursive: true })
      await writeFile(
        join(root, 'node_modules/@adonisjs/ally/package.json'),
        JSON.stringify({ name: '@adonisjs/ally', version: '6.3.2' })
      )
      const inert = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.deepEqual(inert.endpointLocations, [])
      assert.notInclude(
        inert.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.content,
        'registerManagedRoutes('
      )
      const inertHeaders = inert.changes.find(
        ({ path }) => path === 'app/middleware/account_kit_proof_headers_middleware.ts'
      )!.content
      assert.include(inertHeaders, 'export default class AccountKitProofHeadersMiddleware')
      assert.include(inertHeaders, `strategy: "${strategy}"`)
      assert.include(inertHeaders, 'except: ["auth.oauth.redirect"]')
      assert.include(inertHeaders, 'return applyProofHeaders(ctx, next)')
      assert.isFalse(
        inert.diagnostics.some(({ severity }) => severity === 'error'),
        JSON.stringify(inert.diagnostics)
      )
      await applySetup(root, inert)

      choices.authentication!.applicationRouteRevocation = true
      const active = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isFalse(
        active.diagnostics.some(({ severity }) => severity === 'error'),
        JSON.stringify(active.diagnostics)
      )
      assert.include(active.endpoints, 'auth.oauth.callback')
      if (strategy === 'access_tokens') assert.include(active.endpoints, 'auth.oauth.token')
      else assert.notInclude(active.endpoints, 'auth.oauth.token')
      assert.notInclude(active.endpoints, 'auth.oauth.redirect')
      assert.include(
        active.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.content,
        'registerManagedRoutes('
      )
      assert.equal(
        active.changes.find(({ path }) => path === 'start/account_kit_routes.ts')!.action,
        'update'
      )
      await applySetup(root, active)
    }
  })

  test('provider retirement fails closed until inventory proves another usable method in a maintenance window', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const previous = structuredClone(choices)
    previous.features = [
      'authentication',
      'registration',
      'emailVerification',
      'socialAuthentication',
    ]
    previous.managed = ['socialAuthentication']
    previous.social = {
      status: 'enabled',
      providers: ['google', 'github'],
      callbackOriginEnv: 'ACCOUNT_SOCIAL_ORIGIN',
      callbackPath: '/account/auth/oauth/{provider}/callback',
      credentials: {
        google: { clientIdEnv: 'GOOGLE_CLIENT_ID', clientSecretEnv: 'GOOGLE_CLIENT_SECRET' },
        github: { clientIdEnv: 'GITHUB_CLIENT_ID', clientSecretEnv: 'GITHUB_CLIENT_SECRET' },
      },
    }
    await writeFile(join(root, 'config/account_kit_setup.json'), JSON.stringify(previous))
    const state = await inspectSetup(root)
    const next = structuredClone(previous)
    next.social = {
      ...previous.social,
      providers: ['github'],
      credentials: {
        github:
          previous.social.status === 'enabled' ? previous.social.credentials.github : undefined,
      },
    }
    const missing = await planSetup(next, state)
    assert.include(
      missing.diagnostics.map(({ field }) => field),
      'social.retirement'
    )
    const impact = {
      inspectedAccounts: 5,
      affectedAccounts: 1,
      checkedAt: new Date().toISOString(),
    }
    const affected = await planSetup(next, state, {
      retirementImpact: impact,
      retirementMaintenanceWindow: true,
    })
    assert.include(
      affected.diagnostics.find(({ field }) => field === 'social.retirement')!.message,
      '1 of 5'
    )
    const zero = await planSetup(next, state, {
      retirementImpact: { ...impact, affectedAccounts: 0 },
    })
    assert.include(
      zero.diagnostics.find(({ field }) => field === 'social.retirement')!.message,
      '--retirement-maintenance-window'
    )
    const allowed = await planSetup(next, state, {
      retirementImpact: { ...impact, affectedAccounts: 0 },
      retirementMaintenanceWindow: true,
    })
    assert.notInclude(
      allowed.diagnostics.map(({ field }) => field),
      'social.retirement'
    )
  })

  test('retirement uses a DB-derived count and a declared maintenance window', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    const previous = structuredClone(choices)
    previous.features.push('authentication')
    previous.managed.push('authentication')
    await writeFile(join(root, 'config/account_kit_setup.json'), `${JSON.stringify(previous)}\n`)
    choices.authentication = null
    choices.managed = []
    const state = await inspectSetup(root)
    const impact = {
      inspectedAccounts: 9,
      affectedAccounts: 3,
      checkedAt: new Date().toISOString(),
    }
    const blocked = await planSetup(choices, state, { retirementImpact: impact })
    assert.include(
      blocked.diagnostics.find(({ field }) => field === 'authentication.retirement')!.message,
      '3 of 9'
    )
    const zero = { ...impact, affectedAccounts: 0 }
    const withoutWindow = await planSetup(choices, state, { retirementImpact: zero })
    assert.include(
      withoutWindow.diagnostics.map(({ field }) => field),
      'authentication.retirement'
    )
    const allowed = await planSetup(choices, state, {
      retirementImpact: zero,
      retirementMaintenanceWindow: true,
    })
    assert.notInclude(
      allowed.diagnostics.map(({ field }) => field),
      'authentication.retirement'
    )
    choices.authentication = previous.authentication
    const routeOnly = await planSetup(choices, state)
    assert.notInclude(
      routeOnly.diagnostics.map(({ field }) => field),
      'authentication.retirement'
    )
  })

  test('runtime provider drift requires retirement inventory even when persisted choices agree', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.features.push('socialAuthentication')
    choices.social = {
      status: 'enabled',
      providers: ['google'],
      callbackOriginEnv: 'APP_URL',
      callbackPath: '/account/auth/oauth/{provider}/callback',
      credentials: {
        google: { clientIdEnv: 'GOOGLE_CLIENT_ID', clientSecretEnv: 'GOOGLE_CLIENT_SECRET' },
      },
    }
    await writeFile(join(root, 'config/account_kit_setup.json'), `${JSON.stringify(choices)}\n`)
    const impact = {
      inspectedAccounts: 2,
      affectedAccounts: 1,
      checkedAt: new Date().toISOString(),
      currentProviders: ['google', 'github'] as Array<'google' | 'github'>,
      currentPasswordLogin: true,
    }
    const plan = await planSetup(choices, await inspectSetup(root), { retirementImpact: impact })
    assert.include(
      plan.diagnostics.map(({ field }) => field),
      'social.retirement'
    )
  })
})
