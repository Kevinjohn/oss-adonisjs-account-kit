import { configProvider } from '@adonisjs/core/config'
import { protectManagedSessionConfig } from '../../src/http/session_store_protection.js'

export class ServerStore {}

export async function protectedContext(
  selected: () => unknown = () => new ServerStore(),
  store = 'browser',
  verifyStore: (value: unknown) => boolean = (value) => value instanceof ServerStore
) {
  const config = await configProvider.resolve<{
    store: string
    stores: Record<string, (context: never, config: never) => unknown>
  }>(
    {} as never,
    protectManagedSessionConfig(
      configProvider.create(async () => ({ store, stores: { [store]: selected } })),
      {
        verifyStore,
      }
    )
  )
  if (!config) throw new Error('Test session config did not resolve')
  const context = {} as never
  config.stores[store](context, config as never)
  return { context, config }
}
