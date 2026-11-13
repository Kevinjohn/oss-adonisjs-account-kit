import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Application } from '@adonisjs/core/app'
import { migrationSchema } from './migration_definitions.js'
import { stubsRoot } from '../../stubs/main.js'
import type { SetupChoices } from './types.js'

type StubsManager = Awaited<ReturnType<Application<any>['stubs']['create']>>

let stubsManager: Promise<StubsManager> | undefined

/**
 * Setup does not boot the application, so it renders through the stubs manager of a bare
 * application rooted at the package's stubs: the template engine and state that configure's
 * `codemods.makeUsingStub` uses, without writing a file or reading application stubs.
 */
function packageStubs(): Promise<StubsManager> {
  stubsManager ??= (async () => {
    const app = new Application(pathToFileURL(`${stubsRoot}/`), { environment: 'console' })
    app.rcContents({})
    await app.init()
    return app.stubs.create()
  })()
  return stubsManager
}

export async function migrationContent(name: string, choices: SetupChoices): Promise<string> {
  const stubPath = `migrations/${name}.stub`
  try {
    await access(join(stubsRoot, stubPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error(`Account Kit migration template ${name} is missing`)
  }
  const stubs = await packageStubs()
  const stub = await stubs.build(stubPath, { source: stubsRoot })
  const { contents } = await stub.prepare({
    migration: {
      ...migrationSchema(choices.user.table, choices.user.idType),
      // The stub header requires an absolute destination; setup chooses the path in its plan.
      destination: join(stubsRoot, 'migrations', `${name}.ts`),
    },
  })
  // The stubs engine trims the file and keeps the blank line after the header; setup writes the
  // body alone with one trailing newline.
  return `${contents.trim()}\n`
}
