import { assert } from '@japa/assert'
import app from '@adonisjs/core/services/app'
import type { Config } from '@japa/runner/types'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'
import { dbAssertions } from '@adonisjs/lucid/plugins/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { browserClient } from '@japa/browser-client'
import { authBrowserClient } from '@adonisjs/auth/plugins/browser_client'
import { sessionBrowserClient } from '@adonisjs/session/plugins/browser_client'
import router from '@adonisjs/core/services/router'
import { errors } from 'adonisjs-account-kit'
import kit from 'adonisjs-account-kit/services/main'
import { middleware } from '#start/kernel'

/**
 * This file is imported by the "bin/test.ts" entrypoint file
 */

/**
 * Configure Japa plugins in the plugins array.
 * Learn more - https://japa.dev/docs/runner-config#plugins-optional
 */
export const plugins: Config['plugins'] = [
  assert(),
  pluginAdonisJS(app),
  dbAssertions(app),
  browserClient({ runInSuites: ['browser'] }),
  sessionBrowserClient(app),
  authBrowserClient(app),
]

/**
 * Configure lifecycle function to run before and after all the
 * tests.
 *
 * The setup functions are executed before all the tests
 * The teardown functions are executed after all the tests
 */
export const runnerHooks: Required<Pick<Config, 'setup' | 'teardown'>> = {
  setup: [
    () => {
      // Register before any suite starts the shared HTTP server. Functional suites run before
      // browser suites in a full run, so browser-suite setup would register this route too late.
      router
        .get('/__test__/confirmed-account', async (ctx) => {
          const revision = ctx.session.get('accountKitRevision')
          try {
            const account = await kit.authentication.requireActive({
              userId: ctx.auth.getUserOrFail().id,
              ...(revision === undefined ? {} : { revision: revision === '' ? null : revision }),
            })
            return ctx.response.ok({ userId: account.id })
          } catch (error) {
            if (!(error instanceof errors.UnverifiedEmailError)) throw error
            return ctx.response.forbidden({ reason: 'verification_required' })
          }
        })
        .use(middleware.auth())
    },
  ],
  teardown: [],
}

/**
 * Configure suites by tapping into the test suite instance.
 * Learn more - https://japa.dev/docs/test-suites#lifecycle-hooks
 */
export const configureSuite: Config['configureSuite'] = (suite) => {
  if (['browser', 'functional', 'e2e'].includes(suite.name)) {
    return suite.setup(() => testUtils.httpServer().start())
  }
}
