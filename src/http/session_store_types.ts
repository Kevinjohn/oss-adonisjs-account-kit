import type { HttpContext } from '@adonisjs/core/http'

/** A session store factory as AdonisJS session config declares it. */
export type ManagedSessionStoreFactory = (context: HttpContext, config: never) => unknown

/** The part of a session config `protectManagedSessionConfig` reads: the selected store. */
export type ManagedSessionConfiguration = {
  /** The selected store name. */
  store: string
  /** The configured store factories. */
  stores: Record<string, ManagedSessionStoreFactory>
}
