import { test } from '@japa/runner'
import type { AccountKit } from '../index.ts'

test('the AccountKit constructor does not accept encryption', ({ expectTypeOf }) => {
  expectTypeOf<ConstructorParameters<typeof AccountKit>[0]>().not.toHaveProperty('encryption')
})
