import { RuntimeException } from '@adonisjs/core/exceptions'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IgnitorFactory } from '@adonisjs/core/factories'
import type { buildMigrationTemplateData } from './migration_definitions.ts'
import { stubsRoot } from '../../stubs/main.ts'

type StubsManager = Awaited<
  ReturnType<ReturnType<ReturnType<IgnitorFactory['create']>['createApp']>['stubs']['create']>
>

/**
 * Setup does not boot the application, so it renders through the stubs manager of a bare
 * application rooted at the package's stubs: the template engine and state that configure's
 * `codemods.makeUsingStub` uses, without writing a file or reading application stubs.
 */
async function loadPackageStubs(): Promise<StubsManager> {
  const ignitor = new IgnitorFactory().create(pathToFileURL(`${stubsRoot}/`))
  const app = ignitor.createApp('console')
  app.rcContents({})
  await app.init()
  return app.stubs.create()
}

/** Locates one template and returns its stub path. It reads no setup choice. */
export async function requireMigrationTemplatePath(name: string): Promise<string> {
  const stubPath = `make/migration/${name}.stub`
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
  schema: ReturnType<typeof buildMigrationTemplateData>
): Promise<string> {
  const stubs = await loadPackageStubs()
  const stub = await stubs.build(stubPath, { source: stubsRoot })
  const { contents } = await stub.prepare({
    migration: {
      ...schema,
      // Setup writes to the inspected migration directory in the plan, outside the renderer.
      path: stubPath
        .split('/')
        .at(-1)!
        .replace(/\.stub$/, '.ts'),
    },
  })
  // The stubs engine trims the file and keeps the blank line after the header; setup writes the
  // body alone with one trailing newline.
  return `${contents.trim()}\n`
}
