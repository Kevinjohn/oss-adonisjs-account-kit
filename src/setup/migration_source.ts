import { RuntimeException } from '@adonisjs/core/exceptions'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Application } from '@adonisjs/core/app'
import type { buildMigrationSchema } from './migration_definitions.js'
import { stubsRoot } from '../../stubs/main.js'

type StubsManager = Awaited<ReturnType<Application<any>['stubs']['create']>>

let stubsManager: Promise<StubsManager> | undefined

/**
 * Setup does not boot the application, so it renders through the stubs manager of a bare
 * application rooted at the package's stubs: the template engine and state that configure's
 * `codemods.makeUsingStub` uses, without writing a file or reading application stubs.
 */
function loadPackageStubs(): Promise<StubsManager> {
  stubsManager ??= (async () => {
    const app = new Application(pathToFileURL(`${stubsRoot}/`), { environment: 'console' })
    app.rcContents({})
    await app.init()
    return app.stubs.create()
  })()
  return stubsManager
}

/** Locates one template and returns its stub path. It reads no setup choice. */
export async function requireMigrationTemplatePath(name: string): Promise<string> {
  const stubPath = `migrations/${name}.stub`
  try {
    await access(join(stubsRoot, stubPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new RuntimeException(`Account Kit migration template ${name} is missing`)
  }
  return stubPath
}

/** Renders a located template with the schema built from the choices. */
export async function migrationContent(
  stubPath: string,
  schema: ReturnType<typeof buildMigrationSchema>
): Promise<string> {
  const stubs = await loadPackageStubs()
  const stub = await stubs.build(stubPath, { source: stubsRoot })
  const { contents } = await stub.prepare({
    migration: {
      ...schema,
      // The stub header requires an absolute destination; setup chooses the path in its plan.
      destination: join(stubsRoot, stubPath.replace(/\.stub$/, '.ts')),
    },
  })
  // The stubs engine trims the file and keeps the blank line after the header; setup writes the
  // body alone with one trailing newline.
  return `${contents.trim()}\n`
}
