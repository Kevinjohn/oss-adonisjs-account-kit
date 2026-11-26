import { test } from '@japa/runner'
import { E_ACCOUNT_KIT_INVALID_INPUT } from '../src/errors.ts'
import { decodeKeysetCursor, encodeKeysetCursor } from '../src/keyset_cursor.ts'

const LITERAL_CURSOR = 'WyIyMDI2LTAxLTAyVDAzOjA0OjA1LjAwMFoiLDdd'

test.group('keyset cursor', () => {
  test('decodes a fixed cursor and re-encodes it to the same string', ({ assert }) => {
    const position = decodeKeysetCursor(LITERAL_CURSOR, 'Invalid test cursor')

    assert.deepEqual(position, { createdAt: '2026-01-02T03:04:05.000Z', id: 7 })
    assert.equal(encodeKeysetCursor(position.createdAt, position.id), LITERAL_CURSOR)
  })

  test('rejects a malformed cursor with the given message', ({ assert }) => {
    assert.throws(
      () => decodeKeysetCursor('not-a-cursor', 'Invalid test cursor'),
      E_ACCOUNT_KIT_INVALID_INPUT,
      'Invalid test cursor'
    )
  })

  test('rejects an id below 1 and an encoding the encoder would not produce', ({ assert }) => {
    const encode = (json: string) => Buffer.from(json).toString('base64url')
    for (const cursor of [
      encode('["2026-01-02T03:04:05.000Z",0]'),
      encode('["2026-01-02T03:04:05.000Z", 7]'),
    ])
      assert.throws(
        () => decodeKeysetCursor(cursor, 'Invalid test cursor'),
        E_ACCOUNT_KIT_INVALID_INPUT,
        'Invalid test cursor'
      )
  })
})
