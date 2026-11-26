import { test } from '@japa/runner'
import type { UsersAdapter } from '../index.ts'

test('legacy lookup implementations with an optional lock argument remain assignable', ({
  expectTypeOf,
}) => {
  type Trx = Parameters<UsersAdapter['findById']>[1]
  type LegacyLookups = {
    findByEmail(email: string, trx?: Trx, options?: { forUpdate?: boolean }): Promise<null>
    findById(
      id: Parameters<UsersAdapter['findById']>[0],
      trx?: Trx,
      options?: { forUpdate?: boolean }
    ): Promise<null>
  }

  expectTypeOf<LegacyLookups>().toExtend<Pick<UsersAdapter, 'findByEmail' | 'findById'>>()
})

test('the public user lookup cannot request an adapter lock', ({ expectTypeOf }) => {
  type LookupParameters = Parameters<UsersAdapter['findById']>
  expectTypeOf<[1, undefined]>().toExtend<LookupParameters>()
  expectTypeOf<[1, undefined, { forUpdate: true }]>().not.toExtend<LookupParameters>()
})
