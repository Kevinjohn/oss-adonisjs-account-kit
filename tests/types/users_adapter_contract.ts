import type { UsersAdapter } from '../../index.js'

type Trx = Parameters<UsersAdapter['findById']>[1]

/** A custom adapter that still declares the removed `forUpdate` option keeps type-checking. */
export const legacyLookups: Pick<UsersAdapter, 'findByEmail' | 'findById'> = {
  async findByEmail(email: string, trx?: Trx, options?: { forUpdate?: boolean }) {
    return email && trx && options ? null : null
  },
  async findById(id, trx?: Trx, options?: { forUpdate?: boolean }) {
    return id && trx && options ? null : null
  },
}

/** The contract no longer takes a locking option; the package locks rows itself. */
export async function lookupWithoutOption(adapter: UsersAdapter) {
  // @ts-expect-error `findById` takes no third argument.
  await adapter.findById(1, undefined, { forUpdate: true })
}
