import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import { configProvider } from '@adonisjs/core/config'
import { generateManagedOpenApi } from '../src/http/openapi.js'
import { managedRouteRegistration } from '../src/http/route_registration.js'

export default class ManagedOpenApi extends BaseCommand {
  static commandName = 'account-kit:openapi'
  static description = 'Print an OpenAPI 3.1 document for the registered managed routes'
  static options = { startApp: true }

  @flags.string({ description: 'Write the document to this file instead of stdout' })
  declare output?: string

  @flags.string({ description: 'Document title (defaults to the package name)' })
  declare title?: string

  @flags.string({
    flagName: 'api-version',
    description: 'Document version (defaults to the package version)',
  })
  declare apiVersion?: string

  async run(): Promise<void> {
    const router = await this.app.container.make('router')
    // Routes are queued until commit; committing also runs the managed collision checks.
    if (!router.commited) router.commit()
    const registration = managedRouteRegistration(router)
    if (!registration) {
      this.logger.error(
        'No Account Kit managed routes are registered. Call registerManagedRoutes in start/routes.ts.'
      )
      this.exitCode = 1
      return
    }
    const host = await readFile(this.app.makePath('package.json'), 'utf8')
      .then((text) => JSON.parse(text) as { name?: string; version?: string })
      .catch(() => ({}) as { name?: string; version?: string })
    const sessionCookieName = await this.sessionCookieName()
    let document
    try {
      document = generateManagedOpenApi({
        registration,
        info: {
          title: this.title ?? host.name ?? 'Account API',
          version: this.apiVersion ?? host.version ?? '0.0.0',
        },
        sessionCookieName,
      })
    } catch (error) {
      this.logger.error((error as Error).message)
      this.exitCode = 1
      return
    }
    const json = `${JSON.stringify(document, null, 2)}\n`
    if (!this.output) {
      this.logger.log(json.trimEnd())
      return
    }
    const target = resolve(this.app.makePath(), this.output)
    await writeFile(target, json)
    this.logger.success(`Wrote ${target}`)
  }

  /** `config/session.ts` exports a lazy config provider, so it must be resolved for the name. */
  private async sessionCookieName(): Promise<string | undefined> {
    const session = this.app.config.get<unknown>('session', undefined)
    const resolved = (await configProvider.resolve(this.app, session)) ?? session
    return (resolved as { cookieName?: string } | undefined)?.cookieName
  }
}
