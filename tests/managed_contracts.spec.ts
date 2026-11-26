import { test } from '@japa/runner'
import type { ManagedQuery, ManagedRequestBody } from '../src/http/main.ts'

test('the public invitation send body accepts scope', ({ expectTypeOf }) => {
  type SendBody = ManagedRequestBody<'account.invitation.send'>
  expectTypeOf<{ email: string; role: 'member'; scope: string }>().toExtend<SendBody>()
  expectTypeOf<SendBody>().toHaveProperty('scope').toEqualTypeOf<string | undefined>()
})

test('the public invitation list query accepts scope', ({ expectTypeOf }) => {
  type ListQuery = ManagedQuery<'account.invitation.list'>
  expectTypeOf<{ limit: number; scope: string }>().toExtend<ListQuery>()
  expectTypeOf<ListQuery>().toHaveProperty('scope').toEqualTypeOf<string | undefined>()
})
