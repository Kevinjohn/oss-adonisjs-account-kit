import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { inspectSetup } from '../src/setup/inspect.js'
import { planSetup } from '../src/setup/plan.js'
import { applySetup } from '../src/setup/apply.js'
import { fixture, registerSetupTeardown } from './helpers/setup.js'

test.group('setup token prerequisites', (group) => {
  registerSetupTeardown(group)

  test('selected token setup requires a proven model provider and matching native guard property', async ({
    assert,
  }) => {
    const { root, choices } = await fixture()
    choices.authentication!.strategy = 'access_tokens'
    choices.authentication!.guard = 'api'
    delete choices.authentication!.session
    choices.authentication!.token = { revocation: true, lifetime: '1d', abilities: ['*'] }
    const modelPath = join(root, 'app/models/user.ts')
    const authPath = join(root, 'config/auth.ts')
    const nativeModel = await readFile(modelPath, 'utf8')
    const nativeAuth = await readFile(authPath, 'utf8')
    const modelCases = [
      nativeModel.replace('DbAccessTokensProvider.forModel(User)', '{}'),
      nativeModel.replace('DbAccessTokensProvider.forModel(User)', 'opaqueProvider'),
      nativeModel.replace(
        'DbAccessTokensProvider.forModel(User)',
        'DbAccessTokensProvider.forModel(Other)'
      ),
      nativeModel.replace('DbAccessTokensProvider.forModel(User)', 'OtherProvider.forModel(User)'),
      `${nativeModel}\nDbAccessTokensProvider.forModel = () => ({})\n`,
    ]
    for (const model of modelCases) {
      await writeFile(modelPath, model)
      const plan = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'user.model' && severity === 'error'
        ),
        model
      )
      await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
      assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
    }
    await writeFile(
      modelPath,
      nativeModel
        .replace(
          'import { DbAccessTokensProvider }',
          'import { DbAccessTokensProvider as NativeTokens }'
        )
        .replace('DbAccessTokensProvider.forModel(User)', 'NativeTokens.forModel(User)')
    )
    const aliased = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      aliased.diagnostics.some(
        ({ field, severity }) => field === 'user.model' && severity === 'error'
      ),
      JSON.stringify(aliased.diagnostics)
    )
    await writeFile(
      modelPath,
      nativeModel.replace(
        'DbAccessTokensProvider.forModel(User)',
        '(DbAccessTokensProvider.forModel(User) as typeof DbAccessTokensProvider)'
      )
    )
    const wrapped = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      wrapped.diagnostics.some(
        ({ field, severity }) => field === 'user.model' && severity === 'error'
      ),
      JSON.stringify(wrapped.diagnostics)
    )
    await writeFile(modelPath, nativeModel)
    for (const configured of ["tokens: 'otherTokens'", 'tokens: tokenProperty', '']) {
      await writeFile(
        authPath,
        nativeAuth.replace("tokens: 'accessTokens',", configured ? `${configured},` : '')
      )
      const plan = await planSetup(choices, await inspectSetup(root), {
        apply: true,
        timestamp: 1234,
      })
      assert.isTrue(
        plan.diagnostics.some(
          ({ field, severity }) => field === 'authentication.guard' && severity === 'error'
        ),
        configured
      )
      await assert.rejects(() => applySetup(root, plan), /blocking diagnostics/)
      assert.notInclude(await readdir(join(root, 'config')), 'account_kit_setup.json')
    }
    await writeFile(authPath, nativeAuth)
    const valid = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      valid.diagnostics.some(
        ({ field, severity }) =>
          ['user.model', 'authentication.guard'].includes(field) && severity === 'error'
      ),
      JSON.stringify(valid.diagnostics)
    )

    await writeFile(
      authPath,
      nativeAuth
        .replace('tokensUserProvider }', 'tokensUserProvider as NativeUserProvider }')
        .replace('tokensUserProvider({', 'NativeUserProvider({')
    )
    const aliasedGuard = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      aliasedGuard.diagnostics.some(
        ({ field, severity }) => field === 'authentication.guard' && severity === 'error'
      ),
      JSON.stringify(aliasedGuard.diagnostics)
    )

    choices.authentication!.strategy = 'session'
    choices.authentication!.guard = 'web'
    delete choices.authentication!.token
    choices.authentication!.session = {
      secureCookie: true,
      csrf: true,
      originChecked: true,
      persistentStore: true,
    }
    await writeFile(modelPath, nativeModel.replace('DbAccessTokensProvider.forModel(User)', '{}'))
    const session = await planSetup(choices, await inspectSetup(root), {
      apply: true,
      timestamp: 1234,
    })
    assert.isFalse(
      session.diagnostics.some(
        ({ field, severity }) => field === 'user.model' && severity === 'error'
      ),
      JSON.stringify(session.diagnostics)
    )
  })
})
