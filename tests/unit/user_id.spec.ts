import { test } from '@japa/runner'
import { isUserId } from '../../src/user_id.js'

test('user IDs are safe integers or nonempty strings without coercion or trimming', ({
  assert,
}) => {
  for (const value of [1, 0, -1, '1', '01', ' ', '3f2b57da-442a-4b93-a24e-60be3d770a56'])
    assert.isTrue(isUserId(value), `accepts ${String(value)}`)
  for (const value of [
    1.5,
    Number.NaN,
    Infinity,
    -Infinity,
    2 ** 53,
    '',
    null,
    undefined,
    {},
    [],
    true,
    1n,
  ])
    assert.isFalse(isUserId(value), `rejects ${String(value)}`)
})
